/*
 * Beownir presentation kit.
 *
 * Dependency-free ANSI presentation helpers for the runtime shell and for any
 * other web page that wants to render the runtime's text through its own text
 * API. The module produces standard ANSI escape sequences; a terminal-like
 * renderer interprets them, so the same strings work in the IDE console, in a
 * log viewer, or piped through a strip() for plain contexts.
 *
 * Two layers:
 *   - styling: paint(text, name), style(text, ...names), and named helpers
 *     (bold, dim, red, green, ...) that no-op when color is disabled;
 *   - composition: success/warn/error/info/hint/step/label/cmd/bullet/rule/
 *     table/banner that build whole lines with consistent semantics.
 *
 * Color mode: 'auto' (follow the registered stream's isTTY), 'always', or
 * 'never'. setTty() binds the detection to a stream; setColorSupport() forces
 * a boolean when no stream is available (other web pages, tests).
 */
(function (global) {
  'use strict';

  var ESC = '\x1b[';
  var RESET = ESC + '0m';

  /* SGR parameters. 30-37 and 90-97 are the standard foreground palette;
   * 1 is bold (often mapped to the bright variants by terminals), 2 dim,
   * 3 italic, 4 underline, 7 inverse, 9 strikethrough. */
  var STYLES = {
    reset: '0', bold: '1', dim: '2', italic: '3', underline: '4',
    inverse: '7', hidden: '8', strike: '9',
  };
  var FOREGROUND = {
    black: '30', red: '31', green: '32', yellow: '33', blue: '34',
    magenta: '35', cyan: '36', white: '37', gray: '90', grey: '90',
    brightRed: '91', brightGreen: '92', brightYellow: '93', brightBlue: '94',
    brightMagenta: '95', brightCyan: '96', brightWhite: '97',
  };

  var state = {
    mode: 'auto',
    ttyStream: null,
    forced: null,
  };

  function setColorMode(mode) {
    if (['auto', 'always', 'never'].indexOf(mode) < 0) {
      throw new Error('Invalid color mode: ' + mode + ' (expected auto, always, or never).');
    }
    state.mode = mode;
  }

  function getColorMode() { return state.mode; }

  /** Bind auto-detection to a stream (any object with an isTTY flag). */
  function setTty(stream) { state.ttyStream = stream || null; }

  /** Force color support on or off, overriding stream detection. */
  function setColorSupport(supported) { state.forced = Boolean(supported); }

  function enabled() {
    if (state.mode === 'always') return true;
    if (state.mode === 'never') return false;
    if (state.forced !== null) return state.forced;
    if (state.ttyStream && typeof state.ttyStream.isTTY !== 'undefined') return Boolean(state.ttyStream.isTTY);
    return false;
  }

  var ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

  /** Remove every ANSI sequence, for plain-text contexts. */
  function strip(text) { return String(text == null ? '' : text).replace(ANSI_RE, ''); }

  function apply(text, codes) {
    if (!codes.length || !enabled()) return String(text);
    return ESC + codes.join(';') + 'm' + text + RESET;
  }

  function paint(text, name) {
    if (FOREGROUND[name]) return apply(text, [FOREGROUND[name]]);
    if (STYLES[name]) return apply(text, [STYLES[name]]);
    throw new Error('Unknown style: ' + name);
  }

  /** Apply several style/color names at once, e.g. style(text, 'bold', 'red'). */
  function style(text, ...names) {
    var codes = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (FOREGROUND[name]) codes.push(FOREGROUND[name]);
      else if (STYLES[name]) codes.push(STYLES[name]);
      else throw new Error('Unknown style: ' + name);
    }
    return apply(text, codes);
  }

  /* Named helpers: p.red('text'), p.bold('text'), ... */
  var named = {};
  Object.keys(STYLES).forEach(function (name) {
    if (name === 'reset') return;
    named[name] = function (text) { return style(text, name); };
  });
  Object.keys(FOREGROUND).forEach(function (name) {
    named[name] = function (text) { return style(text, name); };
  });

  /* ---- composition helpers ---- */

  function line(text) { return String(text == null ? '' : text) + '\n'; }

  /** A command echo: the "> cmd" line npm-style runners print before a script. */
  function cmd(text) { return style('> ' + text, 'dim'); }

  /** A labeled value line: "name: value". */
  function label(name, value) {
    return style(String(name), 'bold') + ': ' + value + '\n';
  }

  function success(text) { return style('✔ ' + text, 'green') + '\n'; }
  function warn(text) { return style('⚠ ' + text, 'yellow') + '\n'; }
  function error(text) { return style('✖ ' + text, 'red') + '\n'; }
  function info(text) { return style('ℹ ' + text, 'cyan') + '\n'; }
  /** A secondary hint, dimmed so it reads as advice, not output. */
  function hint(text) { return style('  ' + text, 'dim') + '\n'; }
  /** A numbered/step marker for multi-phase operations. */
  function step(index, text) { return style('[' + index + '] ' + text, 'cyan') + '\n'; }
  function bullet(text) { return style('• ' + text, 'dim') + '\n'; }

  /** A horizontal rule, dimmed. */
  function rule(width, char) {
    var w = Math.max(0, Math.floor(width || 72));
    var c = char || '─';
    return style(c.repeat(w), 'dim') + '\n';
  }

  /** A boxed banner: title on top, body lines inside, dim borders. */
  function banner(title, lines, width) {
    var w = Math.max(String(title).length + 4, 40);
    if (width) w = Math.max(w, Math.floor(width));
    var top = style('┌' + '─'.repeat(w - 2) + '┐', 'dim');
    var mid = function (text) {
      var pad = w - 2 - String(text).length;
      if (pad < 0) { text = String(text).slice(0, Math.max(0, w - 3)) + '…'; pad = w - 2 - String(text).length; }
      return style('│ ' + text + ' '.repeat(Math.max(0, pad)) + ' │', 'dim');
    };
    var out = top + '\n';
    out += mid(style(String(title), 'bold')) + '\n';
    var body = Array.isArray(lines) ? lines : [lines];
    for (var i = 0; i < body.length; i++) out += mid(String(body[i])) + '\n';
    out += style('└' + '─'.repeat(w - 2) + '┘', 'dim') + '\n';
    return out;
  }

  /** A plain-text table. `rows` is an array of objects with a shared key set,
   * or an array of arrays. Column headers come from object keys or null. */
  function table(rows, options) {
    options = options || {};
    var header = options.header;
    var arrayRows = Array.isArray(rows) && rows.length && Array.isArray(rows[0]);
    var keys;
    if (arrayRows) {
      keys = header ? (Array.isArray(header) ? header : [header]) : null;
    } else {
      keys = header ? (Array.isArray(header) ? header : Object.keys(header || rows[0] || {})) : Object.keys(rows[0] || {});
    }
    var values = arrayRows
      ? rows.map(function (r) { return keys ? r : r.map(String); })
      : rows.map(function (r) { return keys.map(function (k) { return r && r[k] != null ? String(r[k]) : ''; }); });
    if (!keys && !arrayRows) values = rows.map(function (r) { return [String(r)]; });
    if (!keys) keys = values[0] ? values[0].map(function (_, i) { return 'col' + (i + 1); }) : [];

    var widths = keys.map(function (k, i) {
      var w = String(k).length;
      for (var j = 0; j < values.length; j++) w = Math.max(w, String(values[j][i] || '').length);
      return w;
    });
    var dim = style('│', 'dim');
    var out = '';
    if (keys.length) {
      out += style('┌' + widths.map(function (w) { return '─'.repeat(w + 2); }).join('┬') + '┐', 'dim') + '\n';
      out += dim + keys.map(function (k, i) { return ' ' + String(k).padEnd(widths[i]) + ' ' + dim; }).join(style('│', 'dim')) + dim + '\n';
      out += style('├' + widths.map(function (w) { return '─'.repeat(w + 2); }).join('┼') + '┤', 'dim') + '\n';
    } else {
      out += style('┌' + '─'.repeat(2) + '┐', 'dim') + '\n';
    }
    for (var r = 0; r < values.length; r++) {
      out += dim + values[r].map(function (v, i) { return ' ' + String(v).padEnd(widths[i]) + ' ' + dim; }).join(style('│', 'dim')) + dim + '\n';
    }
    out += style('└' + widths.map(function (w) { return '─'.repeat(w + 2); }).join('┴') + '┘', 'dim') + '\n';
    return out;
  }

  var api = {
    /* state */
    setColorMode: setColorMode,
    getColorMode: getColorMode,
    setTty: setTty,
    setColorSupport: setColorSupport,
    enabled: enabled,
    /* primitives */
    paint: paint,
    style: style,
    strip: strip,
    /* named styles */
    bold: named.bold,
    dim: named.dim,
    italic: named.italic,
    underline: named.underline,
    inverse: named.inverse,
    strike: named.strike,
    red: named.red,
    green: named.green,
    yellow: named.yellow,
    blue: named.blue,
    magenta: named.magenta,
    cyan: named.cyan,
    white: named.white,
    gray: named.gray,
    grey: named.grey,
    brightRed: named.brightRed,
    brightGreen: named.brightGreen,
    brightYellow: named.brightYellow,
    brightBlue: named.brightBlue,
    brightMagenta: named.brightMagenta,
    brightCyan: named.brightCyan,
    brightWhite: named.brightWhite,
    /* composition */
    line: line,
    cmd: cmd,
    label: label,
    success: success,
    warn: warn,
    error: error,
    info: info,
    hint: hint,
    step: step,
    bullet: bullet,
    rule: rule,
    banner: banner,
    table: table,
  };

  var BeownirPresent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = BeownirPresent;
  if (global) global.BeownirPresent = BeownirPresent;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
