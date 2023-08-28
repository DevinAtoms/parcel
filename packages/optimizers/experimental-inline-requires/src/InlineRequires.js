import {Optimizer} from '@parcel/plugin';
import {parse, print} from '@swc/core';
import {Visitor} from '@swc/core/Visitor';

// Helper function to wrap an existing node in a sequence expression, that is, it
// will take a node `n` and return the AST for `(0, n)`
//
// This ensures that the require call can be correctly used in any context - where
// the sequence is redundant, the minifier will optimise it away.
function getReplacementExpression(requireCallNode) {
  return {
    type: 'ParenthesisExpression',
    span: {start: 0, end: 0, ctxt: 0},
    expression: {
      type: 'SequenceExpression',
      span: {start: 0, end: 0, ctxt: 0},
      expressions: [
        {
          type: 'NumericLiteral',
          span: {start: 0, end: 0, ctxt: 0},
          value: 0,
        },
        requireCallNode,
      ],
    },
  };
}

class PackagedModuleVisitor extends Visitor {
  constructor({bundle, logger, publicIdToAssetSideEffects}) {
    super();
    this.inModuleDefinition = false;
    this.moduleVariables = new Set();
    this.moduleVariableMap = new Map();
    this.dirty = false;
    this.logger = logger;
    this.bundle = bundle;
    this.publicIdToAssetSideEffects = publicIdToAssetSideEffects;
  }

  visitFunctionExpression(n) {
    // This visitor tries to find module definition functions, these are of the form:
    //
    // parcelRequire.register("moduleId", function (require, module, exports) { ... });
    //
    // We do this to set the vistior variable `inModuleDefinition` for subsequent visits,
    // and also reset the module variable tracking data structures.
    //
    // (TODO: Support arrow functions if we modify the runtime to output arrow functions)

    // For ease of comparison, map the arg identifiers to an array of strings.. this will skip any
    // functions with non-identifier args (e.g. spreads etc..)
    const args = n.params.map(param => {
      if (param.pat.type === 'Identifier') {
        return param.pat.value;
      }
      return null;
    });

    if (
      args[0] === 'require' &&
      args[1] === 'module' &&
      args[2] === 'exports'
    ) {
      // `inModuleDefinition` is either null, or the module definition node
      this.inModuleDefinition = n;
      this.moduleVariables = new Set();
      this.moduleVariableMap = new Map();
    }

    // Make sure we visit the function itself
    let result = super.visitFunctionExpression(n);

    // only "exit" module definition if we're exiting the module definition node
    if (n === this.inModuleDefinition) {
      this.inModuleDefinition = false;
    }
    return result;
  }

  visitVariableDeclaration(n) {
    // We're looking for variable declarations that look like this:
    //
    // `var $acw62 = require("acw62");`

    let unusedDeclIndexes = [];
    for (let i = 0; i < n.declarations.length; i++) {
      let decl = n.declarations[i];
      const init = decl.init;
      if (!init || init.type !== 'CallExpression') {
        continue;
      }

      if (
        (init.callee.value === 'require' ||
          init.callee.value === 'parcelRequire') &&
        decl.id.value !== 'parcelHelpers' && // ignore var parcelHelpers = require("@parcel/transformer-js/src/esmodule-helpers.js");
        init.arguments[0].expression.type === 'StringLiteral' &&
        decl.id.value.startsWith('$')
      ) {
        const assetPublicId = decl.id.value.substring(1);

        // We need to determine whether the asset we're require'ing has sideEffects - if it does, we
        // shouldn't optimise it to an inline require as the side effects need to run immediately
        //
        // We need to use the public id of the asset (which is the variable name used for requiring it) in
        // order to find the asset in the bundle graph, and check whether `asset.sideEffects` is true - in
        // which case we skip optimising this asset.
        //
        // This won't work in dev mode, because the id used to require the asset isn't the public id
        if (
          !this.publicIdToAssetSideEffects ||
          !this.publicIdToAssetSideEffects.has(assetPublicId)
        ) {
          this.logger.warn({
            message: `${this.bundle.name}: Unable to resolve ${assetPublicId} to an asset! Assuming sideEffects are present.`,
          });
        } else {
          const asset = this.publicIdToAssetSideEffects.get(assetPublicId);
          if (asset.sideEffects) {
            this.logger.verbose({
              message: `Skipping optimisation of ${assetPublicId} (${asset.filePath}) as it declares sideEffects`,
            });
            // eslint-disable-next-line no-continue
            continue;
          }
        }

        // The moduleVariableMap contains a mapping from (e.g. $acw62 -> the AST node `require("acw62")`)
        this.moduleVariableMap.set(decl.id.value, init);
        // The moduleVariables set is just the used set of modules (e.g. `$acw62`)
        this.moduleVariables.add(decl.id.value);

        this.logger.verbose({
          message: `${this.bundle.name}: Found require of ${decl.id.value} for replacement`,
        });

        // Replace this with a null declarator, we'll use the `init` where it's declared.
        //
        // This mutates `var $acw62 = require("acw62")` -> `var $acw62 = null`
        //
        // The variable will be unused and removed by optimisation
        decl.init = null;
        unusedDeclIndexes.push(i);
      } else if (
        decl.id.type === 'Identifier' &&
        decl.id.value.endsWith('Default') &&
        decl.id.value.startsWith('$')
      ) {
        // Handle modules with default values, these look like this in the source:
        // ```
        // var _app = require("./App");
        // var _appDefault = parcelHelpers.interopDefault(_app);
        // ```
        //
        // In this case we want to also put `_appDefault` into the `moduleVariableMap` with the initializer node,
        // but we want to replace `_app` in there with `require("./App")`.. to summarise, this code will end up looking like:
        //
        // ```
        // var _app = null;
        // var _appDefault = null;
        // ```
        //
        // .. and where `_appDefault` is used we replace that with `parcelHelpers.interopDefault(require('./App'))`
        const baseId = decl.id.value.substring(
          0,
          decl.id.value.length - 'Default'.length,
        );
        if (!this.moduleVariables.has(baseId)) {
          continue;
        }
        init.arguments[0] = {
          spread: null,
          expression: this.moduleVariableMap.get(baseId),
        };
        this.moduleVariableMap.set(decl.id.value, init);
        this.moduleVariables.add(decl.id.value);

        decl.init = null;
        unusedDeclIndexes.push(i);
      }
    }
    if (unusedDeclIndexes.length === 0) {
      return super.visitVariableDeclaration(n);
    } else {
      this.dirty = true;
      return n;
    }
  }

  visitIdentifier(n) {
    // This does the actual replacement - for any identifier within this factory function
    // that is in the `moduleVariables` list, replace the identifier with the original expression
    // that was going to be used to initialise the identifier.
    //
    // The replacement expression uses the `(0, require(...))` pattern to allow for safe replacement
    // in any use cases (since we're replacing a variable access with a function call) - the minifier
    // will take care of optimising this away where possible.
    //
    // e.g.
    // var $abc = require("abc");
    // console.log($abc.foo());
    //
    // becomes
    //
    // var $abc;
    // console.log((0, require("abc")).foo);
    //
    if (this.moduleVariables.has(n.value)) {
      const replacement = getReplacementExpression(
        this.moduleVariableMap.get(n.value),
      );
      n.type = replacement.type;
      n.span = replacement.span;
      n.expression = replacement.expression;
      delete n.value;
      return n;
    } else {
      return super.visitIdentifier(n);
    }
  }
}

let publicIdToAssetSideEffects = null;

module.exports = new Optimizer({
  loadBundleConfig({bundleGraph, logger}) {
    if (publicIdToAssetSideEffects !== null) {
      return {publicIdToAssetSideEffects};
    }

    publicIdToAssetSideEffects = new Map();
    logger.verbose({
      message: 'Generating publicIdToAssetSideEffects for require optimisation',
    });
    bundleGraph.traverse(node => {
      if (node.type === 'asset') {
        const publicId = bundleGraph.getAssetPublicId(node.value);
        publicIdToAssetSideEffects.set(publicId, {
          sideEffects: node.value.sideEffects,
          filePath: node.value.filePath,
        });
      }
    });
    logger.verbose({message: 'Generation complete'});
    return {publicIdToAssetSideEffects};
  },

  async optimize({bundle, options, contents, map, logger, bundleConfig}) {
    if (options.mode !== 'production') {
      return {contents, map};
    }

    try {
      const ast = await parse(contents.toString('utf8'));
      const visitor = new PackagedModuleVisitor({
        bundle,
        logger,
        publicIdToAssetSideEffects: bundleConfig.publicIdToAssetSideEffects,
      });
      visitor.visitProgram(ast);
      if (visitor.dirty) {
        const newContents = await print(ast, {});
        return {contents: newContents.code, map};
      }
    } catch (err) {
      logger.error({
        origin: 'parcel-optimizer-experimental-inline-requires',
        message: `Unable to optimise requires for ${bundle.name}: ${err.message}`,
        stack: err.stack,
      });
    }
    return {contents, map};
  },
});
