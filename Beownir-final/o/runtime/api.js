/*
 * Beownir runtime API — the stable public contract.
 *
 * Third-party editors built in plain HTML/CSS/JS can drive the whole IDE
 * runtime through this API: run Node.js processes, manage files, serve HTTP,
 * install and run npm packages, and render output with the shared presentation
 * kit. The module is self-contained; the runtime passes its internals in via
 * create(), so the contract stays stable while the implementation can evolve.
 *
 * Contract:
 *   - every method is async and returns a Promise;
 *   - every failure is a BeownirAPIError with a stable string `code`
 *     (ENOENT, EINVAL, ENOTCAPABLE, ERR_API_*, ...), a `command` when the
 *     failure came from a process, and `stderr` when output was captured;
 *   - `describe()` returns the whole contract as plain data so an editor can
 *     introspect capabilities without reading this file.
 *
 * Methods:
 *   exec(command, args?, opts?)        -> { code, stdout, stderr, command }
 *   spawn(command, args?, opts?)       -> Process (Node child_process shape)
 *   shell(line, opts?)                 -> { code, stdout, stderr }
 *   run(command, opts?)                -> number (exit code)
 *   npm.install(opts?) / npm.run(script, args?) / npm.view(name)
 *   npm.ls() / npm.uninstall(name) / npm.exec(cmd, args?)
 *   fs.readFile / writeFile / readdir / stat / exists / remove / mkdir / watch
 *   http.request(opts)                 -> { status, headers, body }
 *   http.serve(handler, opts?)         -> { port, url, close() }
 *   present                            -> the presentation kit
 *   describe()                         -> the contract, as data
 */
(function (global) {
  'use strict';

  var API_VERSION = '1.0.0';
  var RUNTIME_NAME = 'beownir-runtime';

  function BeownirAPIError(message, options) {
    options = options || {};
    var error = new Error(message);
    error.name = 'BeownirAPIError';
    error.code = options.code || 'ERR_API_ERROR';
    error.command = options.command;
    error.stderr = options.stderr;
    error.signal = options.signal;
    error.exitCode = options.exitCode;
    error.api = true;
    return error;
  }

  function normalizeError(failure, options) {
    if (failure && failure.api) return failure;
    if (failure && failure.code) {
      return BeownirAPIError(String(failure.message || failure), {
        code: failure.code,
        command: options && options.command,
        stderr: options && options.stderr,
      });
    }
    return BeownirAPIError(String((failure && failure.message) || failure), {
      code: 'ERR_API_ERROR',
      command: options && options.command,
    });
  }

  function toArgv(command, args) {
    var argv = [String(command)];
    if (args != null) {
      if (Array.isArray(args)) {
        for (var i = 0; i < args.length; i++) argv.push(String(args[i]));
      } else {
        argv.push(String(args));
      }
    }
    return argv;
  }

  function validateCommand(command) {
    if (typeof command !== 'string' || !command.trim()) {
      throw BeownirAPIError('A command string is required.', { code: 'ERR_API_INVALID_ARG' });
    }
  }

  function create(internals) {
    if (!internals || typeof internals !== 'object') {
      throw new Error('BeownirAPI.create() requires the runtime internals object.');
    }
    var spawn = internals.spawn;
    var capture = internals.capture;
    var runShellLine = internals.shell;
    var npmImpl = internals.npm || {};
    var fsImpl = internals.fs || {};
    var httpImpl = internals.http || {};
    var present = internals.present || (global && global.BeownirPresent);

    var api = {};

    api.apiVersion = API_VERSION;
    api.runtime = { name: RUNTIME_NAME, version: internals.runtimeVersion || 'unknown' };
    api.capabilities = {
      exec: typeof capture === 'function',
      spawn: typeof spawn === 'function',
      shell: typeof runShellLine === 'function',
      npm: typeof npmImpl.run === 'function',
      fs: typeof fsImpl.readFile === 'function',
      http: typeof httpImpl.request === 'function',
      present: Boolean(present),
    };

    /** Run a command to completion and capture its output. */
    api.exec = async function exec(command, args, opts) {
      validateCommand(command);
      try {
        var result = await capture(toArgv(command, args), opts || {});
        return {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          command: toArgv(command, args).join(' '),
        };
      } catch (failure) {
        throw normalizeError(failure, { command: toArgv(command, args).join(' ') });
      }
    };

    /** Start a long-running process. The result has the Node child_process
     * shape (stdout/stderr streams, write, kill, on) plus done/wait promises. */
    api.spawn = function spawnProcess(command, args, opts) {
      validateCommand(command);
      var child = spawn(toArgv(command, args), opts || {});
      var done = new Promise(function (resolve, reject) {
        child.once('error', function (error) { reject(normalizeError(error, { command: toArgv(command, args).join(' ') })); });
        child.once('close', function (code, signal) {
          resolve({ code: code == null ? null : code, signal: signal || null, killed: Boolean(child.killed) });
        });
      });
      Object.defineProperty(child, 'done', { value: done, enumerable: true });
      Object.defineProperty(child, 'wait', { value: function () { return done; }, enumerable: true });
      return child;
    };

    /** Run a shell command line (sh -c) and capture its output. */
    api.shell = async function shell(line, opts) {
      if (typeof line !== 'string') {
        throw BeownirAPIError('A shell command line string is required.', { code: 'ERR_API_INVALID_ARG' });
      }
      return api.exec('sh', ['-c', line], opts);
    };

    /** Run a command and resolve with just its exit code. */
    api.run = async function run(command, opts) {
      var result = await api.exec(command, [], opts);
      return result.code;
    };

    /* ---- npm ---- */
    api.npm = {
      install: async function install(opts) {
        if (typeof npmImpl.install !== 'function') {
          throw BeownirAPIError('npm install is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await npmImpl.install(opts || {});
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
      run: async function runScript(script, args) {
        if (typeof npmImpl.run !== 'function') {
          throw BeownirAPIError('npm run is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await npmImpl.run([script].concat(args || []));
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
      view: async function view(name) {
        if (typeof npmImpl.view !== 'function') {
          throw BeownirAPIError('npm view is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await npmImpl.view(name);
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
      ls: async function ls() {
        if (typeof npmImpl.ls !== 'function') {
          throw BeownirAPIError('npm ls is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await npmImpl.ls();
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
      uninstall: async function uninstall(name) {
        if (typeof npmImpl.uninstall !== 'function') {
          throw BeownirAPIError('npm uninstall is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await npmImpl.uninstall(name);
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
      exec: async function execNpm(command, args) {
        if (typeof npmImpl.exec !== 'function') {
          throw BeownirAPIError('npm exec is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await npmImpl.exec([command].concat(args || []));
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
    };

    /* ---- fs ---- */
    api.fs = {
      readFile: async function readFile(path, encoding) {
        if (typeof fsImpl.readFile !== 'function') {
          throw BeownirAPIError('fs.readFile is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await fsImpl.readFile(path, encoding);
        } catch (failure) {
          throw normalizeError(failure, { command: 'readFile ' + path });
        }
      },
      writeFile: async function writeFile(path, data) {
        if (typeof fsImpl.writeFile !== 'function') {
          throw BeownirAPIError('fs.writeFile is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await fsImpl.writeFile(path, data);
        } catch (failure) {
          throw normalizeError(failure, { command: 'writeFile ' + path });
        }
      },
      readdir: async function readdir(path) {
        if (typeof fsImpl.readdir !== 'function') {
          throw BeownirAPIError('fs.readdir is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await fsImpl.readdir(path);
        } catch (failure) {
          throw normalizeError(failure, { command: 'readdir ' + path });
        }
      },
      stat: async function stat(path) {
        if (typeof fsImpl.stat !== 'function') {
          throw BeownirAPIError('fs.stat is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await fsImpl.stat(path);
        } catch (failure) {
          throw normalizeError(failure, { command: 'stat ' + path });
        }
      },
      exists: async function exists(path) {
        if (typeof fsImpl.exists !== 'function') {
          throw BeownirAPIError('fs.exists is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        return Boolean(await fsImpl.exists(path));
      },
      remove: async function remove(path) {
        if (typeof fsImpl.remove !== 'function') {
          throw BeownirAPIError('fs.remove is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await fsImpl.remove(path);
        } catch (failure) {
          throw normalizeError(failure, { command: 'remove ' + path });
        }
      },
      mkdir: async function mkdir(path) {
        if (typeof fsImpl.mkdir !== 'function') {
          throw BeownirAPIError('fs.mkdir is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await fsImpl.mkdir(path);
        } catch (failure) {
          throw normalizeError(failure, { command: 'mkdir ' + path });
        }
      },
      watch: function watch(path, handler) {
        if (typeof fsImpl.watch !== 'function') {
          throw BeownirAPIError('fs.watch is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        return fsImpl.watch(path, handler);
      },
    };

    /* ---- http ---- */
    api.http = {
      request: async function request(opts) {
        if (typeof httpImpl.request !== 'function') {
          throw BeownirAPIError('http.request is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        try {
          return await httpImpl.request(opts || {});
        } catch (failure) {
          throw normalizeError(failure);
        }
      },
      serve: function serve(handler, opts) {
        if (typeof httpImpl.serve !== 'function') {
          throw BeownirAPIError('http.serve is not available in this runtime.', { code: 'ERR_API_UNSUPPORTED' });
        }
        return httpImpl.serve(handler, opts || {});
      },
    };

    api.present = present || null;

    /** The full contract as plain data, for editor introspection. */
    api.describe = function describe() {
      return {
        apiVersion: API_VERSION,
        runtime: api.runtime,
        capabilities: api.capabilities,
        errors: {
          format: 'Every failure is an Error with a stable string `code`.',
          codes: ['ENOENT', 'EINVAL', 'ENOTCAPABLE', 'EAGAIN', 'ECONNREFUSED', 'EEXIST', 'EFBIG', 'EPIPE', 'ESRCH', 'ERR_NOT_SUPPORTED', 'ERR_API_ERROR', 'ERR_API_INVALID_ARG', 'ERR_API_UNSUPPORTED'],
        },
        methods: {
          exec: 'exec(command, args?, opts?) -> { code, stdout, stderr, command }',
          spawn: 'spawn(command, args?, opts?) -> Process (done/wait promises, stdout/stderr streams, write, kill)',
          shell: 'shell(line, opts?) -> { code, stdout, stderr }',
          run: 'run(command, opts?) -> number',
          npm: 'install / run / view / ls / uninstall / exec',
          fs: 'readFile / writeFile / readdir / stat / exists / remove / mkdir / watch',
          http: 'request(opts) -> { status, headers, body }; serve(handler, opts) -> { port, url, close }',
          present: 'the BeownirPresent presentation kit',
        },
      };
    };

    return api;
  }

  var BeownirAPI = {
    create: create,
    apiVersion: API_VERSION,
    BeownirAPIError: BeownirAPIError,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BeownirAPI;
  if (global) global.BeownirAPI = BeownirAPI;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this);
