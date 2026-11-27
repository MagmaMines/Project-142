// Supplies the handful of Node internals that lib/path.js imports, so the unmodified file
// runs in the worker. Names mirror Node's internal modules.
const uncurry = fn => (self, ...args) => fn.apply(self, args);
const protoMethod = (owner, name) => uncurry(owner.prototype[name]);
const primordials = {
  ArrayPrototypeJoin: protoMethod(Array, 'join'),
  ArrayPrototypeSlice: protoMethod(Array, 'slice'),
  FunctionPrototypeBind: protoMethod(Function, 'bind'),
  StringPrototypeCharCodeAt: protoMethod(String, 'charCodeAt'),
  StringPrototypeIndexOf: protoMethod(String, 'indexOf'),
  StringPrototypeLastIndexOf: protoMethod(String, 'lastIndexOf'),
  StringPrototypeRepeat: protoMethod(String, 'repeat'),
  StringPrototypeReplace: protoMethod(String, 'replace'),
  StringPrototypeSlice: protoMethod(String, 'slice'),
  StringPrototypeSplit: protoMethod(String, 'split'),
  StringPrototypeToLowerCase: protoMethod(String, 'toLowerCase'),
};
const invalidArgument = (name, type, value) => {
  const received = value === null ? 'null' : value === undefined ? 'undefined' : typeof value === 'object' ? 'an instance of ' + (value.constructor && value.constructor.name || 'Object') : 'type ' + typeof value + ' (' + String(value) + ')';
  return Object.assign(new TypeError('The "' + name + '" argument must be of type ' + type + '. Received ' + received), { code: 'ERR_INVALID_ARG_TYPE' });
};
const internals = {
  'internal/constants': {
    CHAR_UPPERCASE_A: 65, CHAR_LOWERCASE_A: 97, CHAR_UPPERCASE_Z: 90, CHAR_LOWERCASE_Z: 122,
    CHAR_DOT: 46, CHAR_FORWARD_SLASH: 47, CHAR_BACKWARD_SLASH: 92, CHAR_COLON: 58, CHAR_QUESTION_MARK: 63,
  },
  'internal/validators': {
    validateObject(value, name) { if (value === null || typeof value !== 'object') throw invalidArgument(name, 'object', value); },
    validateString(value, name) { if (typeof value !== 'string') throw invalidArgument(name, 'string', value); },
  },
  'internal/util': {
    getLazy(compute) { let done = false, value; return () => { if (!done) { value = compute(); done = true; } return value; }; },
    emitExperimentalWarning() {},
    isWindows: false,
    isMacOS: false,
  },
  'internal/deps/minimatch/index': {
    minimatch() { throw new Error('path.matchesGlob needs minimatch, which is not part of the browser runtime'); },
  },
};
const resolveInternal = id => { if (!Object.prototype.hasOwnProperty.call(internals, id)) throw new Error('path needs internal module ' + id); return internals[id]; };

// lib/path.js calls require() for its internals; this is that resolver.
function require(id) { return resolveInternal(id); }
