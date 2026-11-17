// The globals and prototype helpers that Node's querystring files take from `primordials`,
// and the one internal error they throw. Plain code: it may only use JavaScript globals.
const qsUncurry = fn => (self, ...args) => fn.apply(self, args);
const NODE_QS_PRIMORDIALS = Object.freeze({
  Array,
  ArrayIsArray: Array.isArray,
  Int8Array,
  MathAbs: Math.abs,
  NumberIsFinite: Number.isFinite,
  ObjectKeys: Object.keys,
  String,
  StringPrototypeCharCodeAt: qsUncurry(String.prototype.charCodeAt),
  StringPrototypeSlice: qsUncurry(String.prototype.slice),
  StringPrototypeToUpperCase: qsUncurry(String.prototype.toUpperCase),
  NumberPrototypeToString: qsUncurry(Number.prototype.toString),
  decodeURIComponent,
});
class ERR_INVALID_URI extends URIError {
  constructor() { super('URI malformed'); this.code = 'ERR_INVALID_URI'; }
}
const NODE_QS_ERRORS = Object.freeze({ codes: Object.freeze({ ERR_INVALID_URI }) });
