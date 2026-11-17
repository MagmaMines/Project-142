// Pass-through stand-in for lightningcss: Tailwind uses transform() only for the optional
// optimize step. Utilities come from compile(), so output is correct but not minified.
const Features = { Nesting: 1, MediaQueries: 2, Selectors: 4, Colors: 8, Prefixes: 16, Customizations: 32 };
function transform({ code }) { return { code: Buffer.from(code), map: null, dependencies: [], warnings: [] }; }
module.exports = { Features, transform, default: { Features, transform } };
