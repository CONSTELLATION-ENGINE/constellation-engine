# Third-Party Software Notices and Licenses

Constellation Engine ("the Software") incorporates components from the following third-party packages.
Each component is provided under its own license terms, as listed below. The Software itself is
distributed under AGPL-3.0-or-later (see [LICENSE](./LICENSE)).

This file is generated from the production npm dependency tree (`npm ls --prod`) plus a separately
vendored copy of highlight.js. It satisfies attribution requirements under MIT, BSD, ISC, and
Apache-2.0 licenses, and the NOTICE-redistribution clause of Apache-2.0 §4.

---

## Vendored (non-npm) components

### highlight.js — BSD-3-Clause

- **Location in source tree:** `src/vendor/highlight/`
- **Files:** `highlight.min.js` (esbuild IIFE bundle of `highlight.js/lib/common`), `github-dark.min.css`, `LICENSE`
- **Upstream:** https://github.com/highlightjs/highlight.js
- **License text:** see `src/vendor/highlight/LICENSE`
- **Reason for vendoring:** Removes runtime CDN fetch from cdnjs.cloudflare.com so the dashboard remains a fully self-contained, offline-capable, IP-leak-free local app.

---

## Apache-2.0 components — NOTICE attribution

The Apache License 2.0 §4 requires distributing a copy of the license and any `NOTICE` files
shipped by these projects. The license text is reproduced once below; individual upstream NOTICE
files (where present) remain in their respective `node_modules/<pkg>/` directories inside the
packaged `extraResources`.

- `@xenova/transformers@2.17.2` — https://github.com/xenova/transformers.js
- `adler-32@1.3.1` — https://github.com/SheetJS/js-adler32
- `b4a@1.8.0` — https://github.com/holepunchto/b4a
- `bare-events@2.8.2` — https://github.com/holepunchto/bare-events
- `bare-fs@4.5.5` — https://github.com/holepunchto/bare-fs
- `bare-os@3.7.1` — https://github.com/holepunchto/bare-os
- `bare-path@3.0.0` — https://github.com/holepunchto/bare-path
- `bare-stream@2.8.1` — https://github.com/holepunchto/bare-stream
- `bare-url@2.3.2` — https://github.com/holepunchto/bare-url
- `cfb@1.2.2` — https://github.com/SheetJS/js-cfb
- `codepage@1.15.0` — https://github.com/SheetJS/js-codepage
- `crc-32@1.2.2` — https://github.com/SheetJS/js-crc32
- `detect-libc@2.1.2` — https://github.com/lovell/detect-libc
- `events-universal@1.0.1` — https://github.com/holepunchto/events-universal
- `frac@1.1.2` — https://github.com/SheetJS/frac
- `human-signals@8.0.1` — https://github.com/ehmicky/human-signals
- `long@4.0.0` — https://github.com/dcodeIO/long.js
- `pdf-parse@2.4.5` — https://github.com/mehmet-kozan/pdf-parse
- `pdfjs-dist@5.4.296` — https://github.com/mozilla/pdf.js
- `sharp@0.32.6` — https://github.com/lovell/sharp
- `ssf@0.11.2` — https://github.com/SheetJS/ssf
- `text-decoder@1.2.7` — https://github.com/holepunchto/text-decoder
- `tunnel-agent@0.6.0` — https://github.com/mikeal/tunnel-agent
- `typedfastbitset@0.6.1` — https://github.com/lemire/TypedFastBitSet.js
- `wmf@1.0.2` — https://github.com/SheetJS/js-wmf
- `word@0.3.0` — https://github.com/SheetJS/js-word
- `xlsx@0.18.5` — https://github.com/SheetJS/sheetjs

### Apache License 2.0 (full text)

```
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The complete Apache-2.0 text (with §1–§9 and the appendix) is available at:
https://www.apache.org/licenses/LICENSE-2.0.txt

---

## All third-party packages by license

### Apache-2.0 (27)

- `@xenova/transformers@2.17.2` — https://github.com/xenova/transformers.js
- `adler-32@1.3.1` — https://github.com/SheetJS/js-adler32
- `b4a@1.8.0` — https://github.com/holepunchto/b4a
- `bare-events@2.8.2` — https://github.com/holepunchto/bare-events
- `bare-fs@4.5.5` — https://github.com/holepunchto/bare-fs
- `bare-os@3.7.1` — https://github.com/holepunchto/bare-os
- `bare-path@3.0.0` — https://github.com/holepunchto/bare-path
- `bare-stream@2.8.1` — https://github.com/holepunchto/bare-stream
- `bare-url@2.3.2` — https://github.com/holepunchto/bare-url
- `cfb@1.2.2` — https://github.com/SheetJS/js-cfb
- `codepage@1.15.0` — https://github.com/SheetJS/js-codepage
- `crc-32@1.2.2` — https://github.com/SheetJS/js-crc32
- `detect-libc@2.1.2` — https://github.com/lovell/detect-libc
- `events-universal@1.0.1` — https://github.com/holepunchto/events-universal
- `frac@1.1.2` — https://github.com/SheetJS/frac
- `human-signals@8.0.1` — https://github.com/ehmicky/human-signals
- `long@4.0.0` — https://github.com/dcodeIO/long.js
- `pdf-parse@2.4.5` — https://github.com/mehmet-kozan/pdf-parse
- `pdfjs-dist@5.4.296` — https://github.com/mozilla/pdf.js
- `sharp@0.32.6` — https://github.com/lovell/sharp
- `ssf@0.11.2` — https://github.com/SheetJS/ssf
- `text-decoder@1.2.7` — https://github.com/holepunchto/text-decoder
- `tunnel-agent@0.6.0` — https://github.com/mikeal/tunnel-agent
- `typedfastbitset@0.6.1` — https://github.com/lemire/TypedFastBitSet.js
- `wmf@1.0.2` — https://github.com/SheetJS/js-wmf
- `word@0.3.0` — https://github.com/SheetJS/js-word
- `xlsx@0.18.5` — https://github.com/SheetJS/sheetjs

### MIT (290)

- `@babel/code-frame@7.29.0` — https://github.com/babel/babel
- `@babel/helper-validator-identifier@7.28.5` — https://github.com/babel/babel
- `@grammyjs/types@3.25.0` — https://github.com/grammyjs/types
- `@graphty/algorithms@1.7.1` — https://github.com/graphty-org/graphty-monorepo
- `@homebridge/node-pty-prebuilt-multiarch@0.11.14` — https://github.com/homebridge/node-pty-prebuilt-multiarch
- `@hono/node-server@1.19.14` — https://github.com/honojs/node-server
- `@huggingface/jinja@0.2.2` — https://github.com/huggingface/huggingface.js
- `@inquirer/ansi@1.0.2` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/checkbox@4.3.2` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/confirm@5.1.21` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/core@10.3.2` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/editor@4.2.23` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/expand@4.0.23` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/external-editor@1.0.3` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/figures@1.0.15` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/input@4.3.1` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/number@3.0.23` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/password@4.0.23` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/prompts@7.10.1` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/rawlist@4.1.11` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/search@3.2.2` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/select@4.4.2` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/testing@2.1.53` — https://github.com/SBoudrias/Inquirer.js
- `@inquirer/type@3.0.10` — https://github.com/SBoudrias/Inquirer.js
- `@kwsites/file-exists@1.1.1` — https://github.com/kwsites/file-exists
- `@kwsites/promise-deferred@1.1.1` — https://github.com/kwsites/promise-deferred
- `@modelcontextprotocol/sdk@1.29.0` — https://github.com/modelcontextprotocol/typescript-sdk
- `@napi-rs/canvas-linux-x64-gnu@0.1.80` — https://github.com/Brooooooklyn/canvas
- `@napi-rs/canvas@0.1.80` — https://github.com/Brooooooklyn/canvas
- `@pinojs/redact@0.4.0` — https://github.com/pinojs/redact
- `@sec-ant/readable-stream@0.4.1` — https://github.com/Sec-ant/readable-stream
- `@simple-git/args-pathspec@1.0.3` — https://github.com/steveukx/git-js
- `@simple-git/argv-parser@1.1.1` — https://github.com/steveukx/git-js
- `@sindresorhus/merge-streams@4.0.0` — https://github.com/sindresorhus/merge-streams
- `@types/long@4.0.2` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/node@25.5.0` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@types/uuid@10.0.0` — https://github.com/DefinitelyTyped/DefinitelyTyped
- `@xmldom/xmldom@0.8.12` — https://github.com/xmldom/xmldom
- `abort-controller@3.0.0` — https://github.com/mysticatea/abort-controller
- `accepts@2.0.0` — https://github.com/jshttp/accepts
- `ajv-formats@3.0.1` — https://github.com/ajv-validator/ajv-formats
- `ajv@8.20.0` — https://github.com/ajv-validator/ajv
- `ansi-regex@5.0.1` — https://github.com/chalk/ansi-regex
- `ansi-regex@6.2.2` — https://github.com/chalk/ansi-regex
- `ansi-styles@4.3.0` — https://github.com/chalk/ansi-styles
- `ansi-styles@6.2.3` — https://github.com/chalk/ansi-styles
- `argparse@1.0.10` — https://github.com/nodeca/argparse
- `atomic-sleep@1.0.0` — https://github.com/davidmarkclements/atomic-sleep
- `balanced-match@4.0.4` — https://github.com/juliangruber/balanced-match
- `base64-js@1.5.1` — https://github.com/beatgammit/base64-js
- `better-sqlite3@11.10.0` — https://github.com/WiseLibs/better-sqlite3
- `bindings@1.5.0` — https://github.com/TooTallNate/node-bindings
- `bl@4.1.0` — https://github.com/rvagg/bl
- `bluebird@3.4.7` — https://github.com/petkaantonov/bluebird
- `body-parser@2.2.2` — https://github.com/expressjs/body-parser
- `boxen@8.0.1` — https://github.com/sindresorhus/boxen
- `brace-expansion@5.0.5` — https://github.com/juliangruber/brace-expansion
- `buffer@5.7.1` — https://github.com/feross/buffer
- `bytes@3.1.2` — https://github.com/visionmedia/bytes.js
- `call-bind-apply-helpers@1.0.2` — https://github.com/ljharb/call-bind-apply-helpers
- `call-bound@1.0.4` — https://github.com/ljharb/call-bound
- `callsites@3.1.0` — https://github.com/sindresorhus/callsites
- `camelcase@8.0.0` — https://github.com/sindresorhus/camelcase
- `chalk@5.6.2` — https://github.com/chalk/chalk
- `chardet@2.1.1` — https://github.com/runk/node-chardet
- `cli-boxes@3.0.0` — https://github.com/sindresorhus/cli-boxes
- `cli-cursor@5.0.0` — https://github.com/sindresorhus/cli-cursor
- `cli-spinners@2.9.2` — https://github.com/sindresorhus/cli-spinners
- `color-convert@2.0.1` — https://github.com/Qix-/color-convert
- `color-name@1.1.4` — https://github.com/colorjs/color-name
- `color-string@1.9.1` — https://github.com/Qix-/color-string
- `color@4.2.3` — https://github.com/Qix-/color
- `colorette@2.0.20` — https://github.com/jorgebucaran/colorette
- `command-exists@1.2.9` — https://github.com/mathisonian/command-exists
- `commander@14.0.3` — https://github.com/tj/commander.js
- `content-disposition@1.1.0` — https://github.com/jshttp/content-disposition
- `content-type@1.0.5` — https://github.com/jshttp/content-type
- `cookie-signature@1.2.2` — https://github.com/visionmedia/node-cookie-signature
- `cookie@0.7.2` — https://github.com/jshttp/cookie
- `core-util-is@1.0.3` — https://github.com/isaacs/core-util-is
- `cors@2.8.6` — https://github.com/expressjs/cors
- `cosmiconfig@9.0.1` — https://github.com/cosmiconfig/cosmiconfig
- `croner@10.0.1` — https://github.com/hexagon/croner
- `cross-spawn@7.0.6` — https://github.com/moxystudio/node-cross-spawn
- `dateformat@4.6.3` — https://github.com/felixge/node-dateformat
- `debug@4.4.3` — https://github.com/debug-js/debug
- `decompress-response@6.0.0` — https://github.com/sindresorhus/decompress-response
- `deep-extend@0.6.0` — https://github.com/unclechu/node-deep-extend
- `depd@2.0.0` — https://github.com/dougwilson/nodejs-depd
- `dunder-proto@1.0.1` — https://github.com/es-shims/dunder-proto
- `ee-first@1.1.1` — https://github.com/jonathanong/ee-first
- `emoji-regex@10.6.0` — https://github.com/mathiasbynens/emoji-regex
- `emoji-regex@8.0.0` — https://github.com/mathiasbynens/emoji-regex
- `encodeurl@2.0.0` — https://github.com/pillarjs/encodeurl
- `end-of-stream@1.4.5` — https://github.com/mafintosh/end-of-stream
- `env-paths@2.2.1` — https://github.com/sindresorhus/env-paths
- `error-ex@1.3.4` — https://github.com/qix-/node-error-ex
- `es-define-property@1.0.1` — https://github.com/ljharb/es-define-property
- `es-errors@1.3.0` — https://github.com/ljharb/es-errors
- `es-object-atoms@1.1.1` — https://github.com/ljharb/es-object-atoms
- `escape-html@1.0.3` — https://github.com/component/escape-html
- `etag@1.8.1` — https://github.com/jshttp/etag
- `event-target-shim@5.0.1` — https://github.com/mysticatea/event-target-shim
- `eventsource-parser@3.0.8` — https://github.com/rexxars/eventsource-parser
- `eventsource@3.0.7` — git://git@github.com/EventSource/eventsource
- `execa@9.6.1` — https://github.com/sindresorhus/execa
- `express-rate-limit@8.4.1` — https://github.com/express-rate-limit/express-rate-limit
- `express@5.2.1` — https://github.com/expressjs/express
- `extend-shallow@2.0.1` — https://github.com/jonschlinkert/extend-shallow
- `fast-copy@4.0.3` — https://github.com/planttheidea/fast-copy
- `fast-deep-equal@3.1.3` — https://github.com/epoberezkin/fast-deep-equal
- `fast-fifo@1.3.2` — https://github.com/mafintosh/fast-fifo
- `fast-safe-stringify@2.1.1` — https://github.com/davidmarkclements/fast-safe-stringify
- `figures@6.1.0` — https://github.com/sindresorhus/figures
- `file-uri-to-path@1.0.0` — https://github.com/TooTallNate/file-uri-to-path
- `finalhandler@2.1.1` — https://github.com/pillarjs/finalhandler
- `forwarded@0.2.0` — https://github.com/jshttp/forwarded
- `fresh@2.0.0` — https://github.com/jshttp/fresh
- `fs-constants@1.0.0` — https://github.com/mafintosh/fs-constants
- `fs-extra@11.3.4` — https://github.com/jprichardson/node-fs-extra
- `function-bind@1.1.2` — https://github.com/Raynos/function-bind
- `get-east-asian-width@1.5.0` — https://github.com/sindresorhus/get-east-asian-width
- `get-intrinsic@1.3.0` — https://github.com/ljharb/get-intrinsic
- `get-proto@1.0.1` — https://github.com/ljharb/get-proto
- `get-stream@9.0.1` — https://github.com/sindresorhus/get-stream
- `github-from-package@0.0.0` — https://github.com/substack/github-from-package
- `gopd@1.2.0` — https://github.com/ljharb/gopd
- `grammy@1.41.1` — https://github.com/grammyjs/grammY
- `gray-matter@4.0.3` — https://github.com/jonschlinkert/gray-matter
- `handlebars@4.7.9` — https://github.com/handlebars-lang/handlebars.js
- `has-symbols@1.1.0` — https://github.com/inspect-js/has-symbols
- `hasown@2.0.3` — https://github.com/inspect-js/hasOwn
- `help-me@5.0.0` — https://github.com/mcollina/help-me
- `hono@4.12.15` — https://github.com/honojs/hono
- `http-errors@2.0.1` — https://github.com/jshttp/http-errors
- `iconv-lite@0.7.2` — https://github.com/pillarjs/iconv-lite
- `immediate@3.0.6` — https://github.com/calvinmetcalf/immediate
- `import-fresh@3.3.1` — https://github.com/sindresorhus/import-fresh
- `ip-address@10.1.0` — https://github.com/beaugunderson/ip-address
- `ipaddr.js@1.9.1` — https://github.com/whitequark/ipaddr.js
- `is-any-array@3.0.0` — https://github.com/cheminfo-js/is-any-array
- `is-arrayish@0.2.1` — https://github.com/qix-/node-is-arrayish
- `is-arrayish@0.3.4` — https://github.com/qix-/node-is-arrayish
- `is-extendable@0.1.1` — https://github.com/jonschlinkert/is-extendable
- `is-fullwidth-code-point@3.0.0` — https://github.com/sindresorhus/is-fullwidth-code-point
- `is-interactive@2.0.0` — https://github.com/sindresorhus/is-interactive
- `is-plain-obj@4.1.0` — https://github.com/sindresorhus/is-plain-obj
- `is-promise@4.0.0` — https://github.com/then/is-promise
- `is-stream@4.0.1` — https://github.com/sindresorhus/is-stream
- `is-unicode-supported@1.3.0` — https://github.com/sindresorhus/is-unicode-supported
- `is-unicode-supported@2.1.0` — https://github.com/sindresorhus/is-unicode-supported
- `isarray@1.0.0` — https://github.com/juliangruber/isarray
- `jose@6.2.2` — https://github.com/panva/jose
- `joycon@3.1.1` — https://github.com/egoist/joycon
- `js-tokens@4.0.0` — https://github.com/lydell/js-tokens
- `js-yaml@3.14.2` — https://github.com/nodeca/js-yaml
- `js-yaml@4.1.1` — https://github.com/nodeca/js-yaml
- `json-parse-even-better-errors@2.3.1` — https://github.com/npm/json-parse-even-better-errors
- `json-schema-traverse@1.0.0` — https://github.com/epoberezkin/json-schema-traverse
- `jsonfile@6.2.1` — https://github.com/jprichardson/node-jsonfile
- `kind-of@6.0.3` — https://github.com/jonschlinkert/kind-of
- `lie@3.3.0` — https://github.com/calvinmetcalf/lie
- `lines-and-columns@1.2.4` — https://github.com/eventualbuddha/lines-and-columns
- `log-symbols@6.0.0` — https://github.com/sindresorhus/log-symbols
- `math-intrinsics@1.1.0` — https://github.com/es-shims/math-intrinsics
- `media-typer@1.1.0` — https://github.com/jshttp/media-typer
- `merge-descriptors@2.0.0` — https://github.com/sindresorhus/merge-descriptors
- `mime-db@1.54.0` — https://github.com/jshttp/mime-db
- `mime-types@3.0.2` — https://github.com/jshttp/mime-types
- `mimic-function@5.0.1` — https://github.com/sindresorhus/mimic-function
- `mimic-response@3.1.0` — https://github.com/sindresorhus/mimic-response
- `minimist@1.2.8` — https://github.com/minimistjs/minimist
- `minisearch@7.2.0` — https://github.com/lucaong/minisearch
- `mkdirp-classic@0.5.3` — https://github.com/mafintosh/mkdirp-classic
- `ml-array-max@2.0.0` — https://github.com/mljs/array
- `ml-array-min@2.0.0` — https://github.com/mljs/array
- `ml-array-rescale@2.0.0` — https://github.com/mljs/array
- `ml-matrix@6.12.2` — https://github.com/mljs/matrix
- `ms@2.1.3` — https://github.com/vercel/ms
- `nan@2.26.2` — https://github.com/nodejs/nan
- `napi-build-utils@2.0.0` — https://github.com/inspiredware/napi-build-utils
- `negotiator@1.0.0` — https://github.com/jshttp/negotiator
- `neo-async@2.6.2` — https://github.com/suguru03/neo-async
- `node-abi@3.88.0` — https://github.com/electron/node-abi
- `node-addon-api@6.1.0` — https://github.com/nodejs/node-addon-api
- `node-fetch@2.7.0` — https://github.com/bitinn/node-fetch
- `npm-run-path@6.0.0` — https://github.com/sindresorhus/npm-run-path
- `object-assign@4.1.1` — https://github.com/sindresorhus/object-assign
- `object-inspect@1.13.4` — https://github.com/inspect-js/object-inspect
- `on-exit-leak-free@2.1.2` — https://github.com/mcollina/on-exit-or-gc
- `on-finished@2.4.1` — https://github.com/jshttp/on-finished
- `onetime@7.0.0` — https://github.com/sindresorhus/onetime
- `onnx-proto@4.0.4` — https://github.com/chaosmail/onnx-proto
- `onnxruntime-common@1.14.0` — https://github.com/Microsoft/onnxruntime
- `onnxruntime-node@1.14.0` — https://github.com/Microsoft/onnxruntime
- `onnxruntime-web@1.14.0` — https://github.com/Microsoft/onnxruntime
- `ora@8.2.0` — https://github.com/sindresorhus/ora
- `parent-module@1.0.1` — https://github.com/sindresorhus/parent-module
- `parse-json@5.2.0` — https://github.com/sindresorhus/parse-json
- `parse-ms@4.0.0` — https://github.com/sindresorhus/parse-ms
- `parseurl@1.3.3` — https://github.com/pillarjs/parseurl
- `path-is-absolute@1.0.1` — https://github.com/sindresorhus/path-is-absolute
- `path-key@3.1.1` — https://github.com/sindresorhus/path-key
- `path-key@4.0.0` — https://github.com/sindresorhus/path-key
- `path-to-regexp@8.4.2` — https://github.com/pillarjs/path-to-regexp
- `pino-abstract-transport@2.0.0` — https://github.com/pinojs/pino-abstract-transport
- `pino-abstract-transport@3.0.0` — https://github.com/pinojs/pino-abstract-transport
- `pino-pretty@13.1.3` — https://github.com/pinojs/pino-pretty
- `pino-std-serializers@7.1.0` — https://github.com/pinojs/pino-std-serializers
- `pino@9.14.0` — https://github.com/pinojs/pino
- `pkce-challenge@5.0.1` — https://github.com/crouchcd/pkce-challenge
- `platform@1.3.6` — https://github.com/bestiejs/platform.js
- `prebuild-install@7.1.3` — https://github.com/prebuild/prebuild-install
- `pretty-ms@9.3.0` — https://github.com/sindresorhus/pretty-ms
- `process-nextick-args@2.0.1` — https://github.com/calvinmetcalf/process-nextick-args
- `process-warning@5.0.0` — https://github.com/fastify/process-warning
- `proxy-addr@2.0.7` — https://github.com/jshttp/proxy-addr
- `pump@3.0.4` — https://github.com/mafintosh/pump
- `pupt@1.4.1` — https://github.com/apowers313/pupt
- `quick-format-unescaped@4.0.4` — https://github.com/davidmarkclements/quick-format
- `range-parser@1.2.1` — https://github.com/jshttp/range-parser
- `raw-body@3.0.2` — https://github.com/stream-utils/raw-body
- `readable-stream@2.3.8` — https://github.com/nodejs/readable-stream
- `readable-stream@3.6.2` — https://github.com/nodejs/readable-stream
- `real-require@0.2.0` — https://github.com/pinojs/real-require
- `require-from-string@2.0.2` — https://github.com/floatdrop/require-from-string
- `resolve-from@4.0.0` — https://github.com/sindresorhus/resolve-from
- `restore-cursor@5.1.0` — https://github.com/sindresorhus/restore-cursor
- `router@2.2.0` — https://github.com/pillarjs/router
- `safe-buffer@5.1.2` — https://github.com/feross/safe-buffer
- `safe-buffer@5.2.1` — https://github.com/feross/safe-buffer
- `safe-stable-stringify@2.5.0` — https://github.com/BridgeAR/safe-stable-stringify
- `safer-buffer@2.1.2` — https://github.com/ChALkeR/safer-buffer
- `section-matter@1.0.0` — https://github.com/jonschlinkert/section-matter
- `send@1.2.1` — https://github.com/pillarjs/send
- `serve-static@2.2.1` — https://github.com/expressjs/serve-static
- `setimmediate@1.0.5` — https://github.com/YuzuJS/setImmediate
- `shebang-command@2.0.0` — https://github.com/kevva/shebang-command
- `shebang-regex@3.0.0` — https://github.com/sindresorhus/shebang-regex
- `side-channel-list@1.0.1` — https://github.com/ljharb/side-channel-list
- `side-channel-map@1.0.1` — https://github.com/ljharb/side-channel-map
- `side-channel-weakmap@1.0.2` — https://github.com/ljharb/side-channel-weakmap
- `side-channel@1.1.0` — https://github.com/ljharb/side-channel
- `simple-concat@1.0.1` — https://github.com/feross/simple-concat
- `simple-get@4.0.1` — https://github.com/feross/simple-get
- `simple-git@3.36.0` — https://github.com/steveukx/git-js
- `simple-swizzle@0.2.4` — https://github.com/qix-/node-simple-swizzle
- `sonic-boom@4.2.1` — https://github.com/pinojs/sonic-boom
- `statuses@2.0.2` — https://github.com/jshttp/statuses
- `stdin-discarder@0.2.2` — https://github.com/sindresorhus/stdin-discarder
- `streamx@2.23.0` — https://github.com/mafintosh/streamx
- `string_decoder@1.1.1` — https://github.com/nodejs/string_decoder
- `string_decoder@1.3.0` — https://github.com/nodejs/string_decoder
- `string-width@4.2.3` — https://github.com/sindresorhus/string-width
- `string-width@7.2.0` — https://github.com/sindresorhus/string-width
- `strip-ansi@6.0.1` — https://github.com/chalk/strip-ansi
- `strip-ansi@7.2.0` — https://github.com/chalk/strip-ansi
- `strip-bom-string@1.0.0` — https://github.com/jonschlinkert/strip-bom-string
- `strip-final-newline@4.0.0` — https://github.com/sindresorhus/strip-final-newline
- `strip-json-comments@2.0.1` — https://github.com/sindresorhus/strip-json-comments
- `strip-json-comments@5.0.3` — https://github.com/sindresorhus/strip-json-comments
- `tar-fs@2.1.4` — https://github.com/mafintosh/tar-fs
- `tar-fs@3.1.2` — https://github.com/mafintosh/tar-fs
- `tar-stream@2.2.0` — https://github.com/mafintosh/tar-stream
- `tar-stream@3.1.8` — https://github.com/mafintosh/tar-stream
- `teex@1.0.1` — https://github.com/mafintosh/teex
- `thread-stream@3.1.0` — https://github.com/mcollina/thread-stream
- `toidentifier@1.0.1` — https://github.com/component/toidentifier
- `tr46@0.0.3` — https://github.com/Sebmaster/tr46.js
- `type-is@2.0.1` — https://github.com/jshttp/type-is
- `underscore@1.13.8` — https://github.com/jashkenas/underscore
- `undici-types@7.18.2` — https://github.com/nodejs/undici
- `undici@7.24.0` — https://github.com/nodejs/undici
- `unicorn-magic@0.3.0` — https://github.com/sindresorhus/unicorn-magic
- `universalify@2.0.1` — https://github.com/RyanZim/universalify
- `unpipe@1.0.0` — https://github.com/stream-utils/unpipe
- `util-deprecate@1.0.2` — https://github.com/TooTallNate/util-deprecate
- `uuid@11.1.1` — https://github.com/uuidjs/uuid
- `vary@1.1.2` — https://github.com/jshttp/vary
- `whatwg-url@5.0.0` — https://github.com/jsdom/whatwg-url
- `widest-line@5.0.0` — https://github.com/sindresorhus/widest-line
- `wordwrap@1.0.0` — https://github.com/substack/node-wordwrap
- `wrap-ansi@6.2.0` — https://github.com/chalk/wrap-ansi
- `wrap-ansi@9.0.2` — https://github.com/chalk/wrap-ansi
- `ws@8.19.0` — https://github.com/websockets/ws
- `xmlbuilder@10.1.1` — https://github.com/oozcitak/xmlbuilder-js
- `yoctocolors-cjs@2.1.3` — https://github.com/sindresorhus/yoctocolors
- `yoctocolors@2.1.2` — https://github.com/sindresorhus/yoctocolors
- `zod@3.25.76` — https://github.com/colinhacks/zod
- `zod@4.3.6` — https://github.com/colinhacks/zod

### ISC (20)

- `ansi-align@3.0.1` — https://github.com/nexdrew/ansi-align
- `chownr@1.1.4` — https://github.com/isaacs/chownr
- `cli-width@4.1.0` — https://github.com/knownasilya/cli-width
- `foreground-child@3.3.1` — https://github.com/tapjs/foreground-child
- `graceful-fs@4.2.11` — https://github.com/isaacs/node-graceful-fs
- `guid-typescript@1.0.9` — https://github.com/NicolasDeveloper/guid-typescript
- `inherits@2.0.4` — https://github.com/isaacs/inherits
- `ini@1.3.8` — https://github.com/isaacs/ini
- `isexe@2.0.0` — https://github.com/isaacs/isexe
- `mute-stream@2.0.0` — https://github.com/npm/mute-stream
- `once@1.4.0` — https://github.com/isaacs/once
- `picocolors@1.1.1` — https://github.com/alexeyraspopov/picocolors
- `semver@7.7.4` — https://github.com/npm/node-semver
- `setprototypeof@1.2.0` — https://github.com/wesleytodd/setprototypeof
- `signal-exit@4.1.0` — https://github.com/tapjs/signal-exit
- `split2@4.2.0` — https://github.com/mcollina/split2
- `which@2.0.2` — https://github.com/isaacs/node-which
- `wrappy@1.0.2` — https://github.com/npm/wrappy
- `yaml@2.8.4` — https://github.com/eemeli/yaml
- `zod-to-json-schema@3.25.2` — https://github.com/StefanTerdell/zod-to-json-schema

### BSD-3-Clause (18)

- `@protobufjs/aspromise@1.1.2` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/base64@1.1.2` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/codegen@2.0.4` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/eventemitter@1.1.0` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/fetch@1.1.0` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/float@1.0.2` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/inquire@1.1.0` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/path@1.1.2` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/pool@1.1.0` — https://github.com/dcodeIO/protobuf.js
- `@protobufjs/utf8@1.1.0` — https://github.com/dcodeIO/protobuf.js
- `fast-uri@3.1.0` — https://github.com/fastify/fast-uri
- `highlight.js@11.11.1` — https://github.com/highlightjs/highlight.js
- `ieee754@1.2.1` — https://github.com/feross/ieee754
- `protobufjs@6.11.4` — https://github.com/protobufjs/protobuf.js
- `qs@6.15.1` — https://github.com/ljharb/qs
- `secure-json-parse@4.1.0` — https://github.com/fastify/secure-json-parse
- `source-map@0.6.1` — https://github.com/mozilla/source-map
- `sprintf-js@1.0.3` — https://github.com/alexei/sprintf.js

### BSD-2-Clause (8)

- `dingbat-to-unicode@1.0.1` — https://github.com/mwilliamson/dingbat-to-unicode
- `esprima@4.0.1` — https://github.com/jquery/esprima
- `json-schema-typed@8.0.2` — https://github.com/RemyRylan/json-schema-typed
- `lop@0.4.2` — https://github.com/mwilliamson/lop
- `mammoth@1.12.0` — https://github.com/mwilliamson/mammoth.js
- `option@0.2.4` — https://github.com/mwilliamson/node-options
- `uglify-js@3.19.3` — https://github.com/mishoo/UglifyJS
- `webidl-conversions@3.0.1` — https://github.com/jsdom/webidl-conversions

### BlueOak-1.0.0 (8)

- `@isaacs/cliui@9.0.0` — https://github.com/isaacs/cliui
- `glob@11.1.0` — https://github.com/isaacs/node-glob
- `jackspeak@4.2.3` — https://github.com/isaacs/jackspeak
- `lru-cache@11.3.5` — https://github.com/isaacs/node-lru-cache
- `minimatch@10.2.5` — https://github.com/isaacs/minimatch
- `minipass@7.1.3` — https://github.com/isaacs/minipass
- `package-json-from-dist@1.0.1` — https://github.com/isaacs/package-json-from-dist
- `path-scurry@2.0.2` — https://github.com/isaacs/path-scurry

### Python-2.0 (1)

- `argparse@2.0.1` — https://github.com/nodeca/argparse

### MIT* (2)

- `sqlite-vec-linux-x64@0.1.7-alpha.2` — https://TODO
- `sqlite-vec@0.1.7-alpha.2` — https://TODO

### BSD* (1)

- `duck@0.1.12` — https://github.com/mwilliamson/duck.js

### Apache* (1)

- `flatbuffers@1.12.0` — https://github.com/google/flatbuffers

### (MIT OR WTFPL) (1)

- `expand-template@2.0.3` — https://github.com/ralphtheninja/expand-template

### (MIT OR GPL-3.0-or-later) (1)

- `jszip@3.10.1` — https://github.com/Stuk/jszip

### (MIT AND Zlib) (1)

- `pako@1.0.11` — https://github.com/nodeca/pako

### (BSD-2-Clause OR MIT OR Apache-2.0) (1)

- `rc@1.2.8` — https://github.com/dominictarr/rc

### (MIT OR CC0-1.0) (1)

- `type-fest@4.41.0` — https://github.com/sindresorhus/type-fest

### AGPL-3.0-or-later (1)

- `constellation-engine@0.3.0`

---

## How to regenerate

```bash
cd constellation-engine-oss
npx --yes license-checker --production --json > /tmp/oss-licenses.json
# then re-run the generator script in scripts/generate-licenses.cjs (if added)
```

Last regenerated: 2026-05-05
Total third-party packages: 382 (npm production tree) + 1 (vendored highlight.js)
