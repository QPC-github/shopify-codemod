import takeWhile from 'lodash/takeWhile';

export default function mochaContextToClosure({source}, {jscodeshift: j}) {
  let currentContext;
  const root = j(source);

  function handleContextMember({node, scope}) {
    const propertyName = node.property.name;

    const propertyFromUpperContext = currentContext.propertyInScope(node.property);

    let newName;

    if (propertyFromUpperContext != null) {
      newName = propertyFromUpperContext.name;
    } else {
      const declaredInScope = scope.lookup(propertyName);
      const declaredInCurrentScope = (declaredInScope === scope);
      const declaredInUpperScope = !declaredInCurrentScope && (declaredInScope != null);
      newName = declaredInUpperScope ? `${propertyName}_fromSetup` : propertyName;

      if (declaredInCurrentScope) {
        j(scope.node)
          .find(j.Identifier, {name: propertyName})
          .replaceWith(() => j.identifier(`${propertyName}_fromSetup`));
      }

      currentContext.addPropertyDescriptor({original: propertyName, name: newName});
    }

    return j.identifier(newName);
  }

  function handleContextPropertyUsage({node}) {
    const contextProperty = currentContext.propertyInScope(node.property);

    if (contextProperty != null) {
      return j.identifier(contextProperty.name);
    }

    return node;
  }

  function handleContextSetter(path) {
    function isScopedToSetup(otherPath) {
      return otherPath.scope.path.parent === path;
    }

    const {node} = path;

    root
      .find(j.MemberExpression, {object: {type: 'ThisExpression'}})
      .filter(isScopedToSetup)
      .replaceWith(handleContextMember);

    return j.callExpression(node.callee, arrowifyCallbackInParams(node.arguments));
  }

  function handleContextUser({node}) {
    const callbackParam = node.arguments[node.arguments.length - 1];

    j(node)
      .find(j.MemberExpression, {object: {type: 'ThisExpression'}})
      .filter((memberPath) => memberPath.scope.node === callbackParam)
      .replaceWith(handleContextPropertyUsage);

    return j.callExpression(node.callee, arrowifyCallbackInParams(node.arguments));
  }

  function updateFunctionWithDeclarations(oldFunction, newDeclarations) {
    const oldBody = oldFunction.body.body;
    const leadingDeclarations = takeWhile(oldBody, (statement) => statement.type === 'VariableDeclaration');
    const otherStatements = oldBody.slice(leadingDeclarations.length);

    return j.functionExpression(
      oldFunction.id,
      oldFunction.params,
      j.blockStatement([
        ...leadingDeclarations,
        ...newDeclarations,
        ...otherStatements,
      ]),
      oldFunction.generator,
      oldFunction.expression,
      oldFunction.async
    );
  }

  function arrowifyFunction(oldFunction) {
    if (oldFunction == null || oldFunction.type !== 'FunctionExpression') {
      return oldFunction;
    }

    return j.arrowFunctionExpression(
      oldFunction.params,
      oldFunction.body,
      oldFunction.generator,
      oldFunction.expression,
      oldFunction.async
    );
  }

  function arrowifyCallbackInParams(params) {
    const otherParams = [...params];
    const callback = arrowifyFunction(otherParams.pop());
    return [...otherParams, callback];
  }

  function handleContext(path, parentContext) {
    const context = new Context(path); // eslint-disable-line no-use-before-define
    const lastCurrentContext = currentContext;
    currentContext = context;

    if (parentContext != null) { parentContext.addContext(context); }

    function isScopedToContext(hookPath) {
      return hookPath.scope.path.parent === path;
    }

    root
      .find(j.CallExpression)
      .filter(isScopedToContext)
      .replaceWith((callPath) => {
        if (setsContextProperties(callPath)) { return handleContextSetter(callPath); }
        if (usesContext(callPath)) { return handleContextUser(callPath); }
        return handleContext(callPath, context);
      });

    currentContext = lastCurrentContext;

    const newDeclarations = context
      .properties
      .map((property) => j.variableDeclaration('let', [
        j.variableDeclarator(j.identifier(property.name), null),
      ]));

    const {arguments: args} = path.node;
    args[args.length - 1] = arrowifyFunction(updateFunctionWithDeclarations(
      args[args.length - 1],
      newDeclarations
    ));

    return path.node;
  }

  return root
    .find(j.CallExpression)
    .filter((contextPath) => contextPath.scope.isGlobal && createsContext(contextPath))
    .replaceWith((contextPath) => handleContext(contextPath))
    .toSource({quote: 'single'});
}

function usesContext({node}) {
  return /^(test|it|teardown|after|afterEach)$/.test(node.callee.name);
}

function createsContext({node}) {
  return /^(suite|describe|context)$/.test(node.callee.name);
}

function setsContextProperties({node}) {
  return /^(setup|before|beforeEach)$/.test(node.callee.name);
}

class Context {
  constructor(path) {
    this.path = path;
    this.properties = [];
    this.parent = null;
    this.suites = [];
  }

  addContext(suite) {
    suite.parent = this;
    this.suites.push(suite);
  }

  addPropertyDescriptor(propertyDescriptor) {
    this.properties.push(propertyDescriptor);
  }

  propertyInScope(property) {
    return this.properties.find((prop) => prop.original === property.name) || (this.parent && this.parent.propertyInScope(property));
  }
}
