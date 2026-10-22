# Gateway translation notes

## Scope and baseline

This translation starts from clean gateway commit `93f026ad3a9a5572c9cf6ce651dd8fcf46fd2419`. The owner saved the original tracked archive at `/private/tmp/xiaozhi-gateway-translation-baseline.tar` before edits.

The changes translate first-party JavaScript comments/docstrings, local diagnostics, the README, and the package description. They do not remove integrations or alter deployment, dependency versions, permissions, networking, or authentication. No server, listener, provider call, package installation, or deployment ran during this work.

The MIT license, author attribution, JavaScript identifiers, environment names, configuration data, client IDs, request/response keys, status values, numeric constants, regular expressions, MQTT/UDP/WebSocket framing, and authentication inputs remain unchanged. Existing English diagnostic constants such as `Malformed Remaining Length` remain exact because code compares them.

## Retained Chinese: exact compatibility and language data

Only the 15 source lines listed below retain Han text. This is a line-level list, not a whole-source exemption. No Chinese technical comments, untranslated maintainer instructions, or untranslated local diagnostics remain.

Each `hash` is SHA-256 of the full UTF-8 source line, including indentation but excluding its newline. The `text` field shows the exact trimmed source line; JSON Unicode escapes encode the original Chinese characters without adding another unreviewed Han region to this note. Each entry gives its full English meaning and specific reason for retention. The spoken template also retains the nested Chinese fallback value for an unknown caller.

```json
[
  {
    "path": "app.js",
    "line": 348,
    "hash": "ef328a89b559615a3fd24bae55e2d182ba5868c4b2cdb076c05ba610824134fb",
    "text": "peerConn.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: peerSessionId, reason: '\u5bf9\u65b9\u5df2\u79bb\u5f00' }));",
    "category": "compatibility-literal",
    "meaning": "The peer has left.",
    "reason": "MQTT goodbye reason sent to the other device. Preserve the wire value for existing clients."
  },
  {
    "path": "app.js",
    "line": 500,
    "hash": "044eccfd2a19d34f13b9473fa0fa8effc8dbaab84b226032daf55873509bd70d",
    "text": "this.sendMqttMessage(JSON.stringify({ type: 'error', message: '\u5904\u7406 hello \u6d88\u606f\u5931\u8d25' }));",
    "category": "compatibility-literal",
    "meaning": "Failed to handle the hello message.",
    "reason": "MQTT error.message sent to the device. Preserve the existing error payload."
  },
  {
    "path": "app.js",
    "line": 1000,
    "hash": "771569e1c761ffcab4a305cd2cf7933263bc939c7b5ef11fd98a67724a9ce37e",
    "text": "return res.status(401).json({ error: '\u672a\u63d0\u4f9b\u6709\u6548\u7684Authorization\u5934' });",
    "category": "compatibility-literal",
    "meaning": "No valid Authorization header was provided.",
    "reason": "HTTP 401 error text in authenticateRequest; keep the public API response unchanged."
  },
  {
    "path": "app.js",
    "line": 1011,
    "hash": "ff48a538a6ce8cc77a38fcaacf3e85a66418b3f47296308c32d5d404e123efab",
    "text": "return res.status(401).json({ error: '\u65e0\u6548\u7684\u6388\u6743\u4ee4\u724c' });",
    "category": "compatibility-literal",
    "meaning": "Invalid authorization token.",
    "reason": "HTTP 401 error text in authenticateRequest; keep the public API response unchanged."
  },
  {
    "path": "app.js",
    "line": 1017,
    "hash": "da22b38657aa768dd6d37bd1ba49c1f64357c5c45127934fa4709a37610f1f67",
    "text": "res.status(401).json({ error: '\u6388\u6743\u9a8c\u8bc1\u5931\u8d25' });",
    "category": "compatibility-literal",
    "meaning": "Authorization validation failed.",
    "reason": "HTTP 401 catch-path response; keep the public API response unchanged."
  },
  {
    "path": "app.js",
    "line": 1028,
    "hash": "0ddaa4bdbdd60501c0adea6aa6a0a1f5faedd3fd62aea8d6b40bc9921538da49",
    "text": "return res.status(500).json({ success: false, error: '\u8bbe\u5907\u672a\u8fde\u63a5' });",
    "category": "compatibility-literal",
    "meaning": "Device is not connected.",
    "reason": "HTTP 500 command-dispatch response; management clients consume the error field."
  },
  {
    "path": "app.js",
    "line": 1047,
    "hash": "dbc3593f722374d589ffc8cfb15f6d5b29c38090bd76c9f6ec3c1971e29f2a9a",
    "text": "res.status(500).json({ success: false, error: '\u6307\u4ee4\u7c7b\u578b\u65e0\u6548' });",
    "category": "compatibility-literal",
    "meaning": "Invalid command type.",
    "reason": "HTTP 500 command-dispatch response; preserve the command API payload."
  },
  {
    "path": "app.js",
    "line": 1062,
    "hash": "5b1ef0fc82e13dc2441900f068c86a7ebc8c7f9b9ad77c1014255afc7931a7c7",
    "text": "return res.status(400).json({ error: 'clientIds\u5fc5\u987b\u662f\u4e00\u4e2a\u6570\u7ec4' });",
    "category": "compatibility-literal",
    "meaning": "clientIds must be an array.",
    "reason": "HTTP 400 device-status response. Preserve clientIds as the request key and the existing error text."
  },
  {
    "path": "app.js",
    "line": 1090,
    "hash": "10c55e23a75c6b28e4bb3ccee3cacc22b069010b952d4605bb1469a46d229e12",
    "text": "return res.status(400).json({ error: '\u7f3a\u5c11\u5fc5\u8981\u53c2\u6570: caller_mac, target_mac' });",
    "category": "compatibility-literal",
    "meaning": "Missing required parameters: caller_mac, target_mac.",
    "reason": "HTTP 400 call-request response. Preserve parameter identifiers and response bytes."
  },
  {
    "path": "app.js",
    "line": 1098,
    "hash": "eed27cb52f70625792f5c9caec5c30ec622e0d63b1996672f070fa0e051f2058",
    "text": "message: '\u5bf9\u65b9\u8bbe\u5907\u4e0d\u5728\u7ebf\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'",
    "category": "compatibility-literal",
    "meaning": "The other device is offline; try again later.",
    "reason": "Call result with status offline. The Java management client forwards message to the caller's tool result, so keep its Chinese language behavior."
  },
  {
    "path": "app.js",
    "line": 1140,
    "hash": "16c180d877868f502e33c4a572598583939ff9350a47283220294344fbc0a792",
    "text": "reason: `[device_call]\u60a8\u6536\u5230\u6765\u81ea${caller_nickname || '\u672a\u77e5'}\u7684\u6765\u7535\uff0c\u662f\u5426\u63a5\u542c\uff1f`,",
    "category": "locale-fixture",
    "meaning": "[device_call] You have an incoming call from <caller_nickname or unknown>. Would you like to answer? The Chinese fallback means unknown.",
    "reason": "The prefix is a parsed command marker. The Python listener strips [device_call] and sends the remaining text to STT/TTS; retain the entire Chinese speech template and its fallback."
  },
  {
    "path": "app.js",
    "line": 1166,
    "hash": "37ef9d1326cf6e115c1fc71c7400f73833e97d20ed5313831121ca362ee6e408",
    "text": "return res.status(400).json({ error: '\u7f3a\u5c11\u5fc5\u8981\u53c2\u6570: mac' });",
    "category": "compatibility-literal",
    "meaning": "Missing required parameter: mac.",
    "reason": "HTTP 400 call-accept response. Preserve the mac key and existing error payload."
  },
  {
    "path": "utils/call-manager.js",
    "line": 30,
    "hash": "866990ca29d003464ac0d4af87ab5ae0db86daab51e430735454f3571bd47427",
    "text": "return { status: 'error', message: '\u5df2\u5728\u901a\u8bdd\u4e2d' };",
    "category": "compatibility-literal",
    "meaning": "Already in a call.",
    "reason": "requestCall returns this message with status error. The HTTP call API serializes it and Java forwards it as a user-facing tool result."
  },
  {
    "path": "utils/call-manager.js",
    "line": 76,
    "hash": "7e71d949d423671fc48bb3ab4b8c11a8ac5554b88a2b54fd8fd024d3839fb685",
    "text": "return { status: 'no_pending', message: '\u6ca1\u6709\u7b49\u5f85\u4e2d\u7684\u901a\u8bdd' };",
    "category": "compatibility-literal",
    "meaning": "There is no pending call.",
    "reason": "joinCall returns this message with status no_pending. The HTTP API forwards the result, so retain the public/localized message."
  },
  {
    "path": "utils/call-manager.js",
    "line": 82,
    "hash": "0ad278fb7f71663c2ebeb673d51d320c6c865fbb97b5a424efd550f63eb48ab7",
    "text": "return { status: 'caller_gone', message: '\u4e3b\u53eb\u65b9\u5df2\u79bb\u5f00\u6216\u901a\u8bdd\u5df2\u8d85\u65f6' };",
    "category": "compatibility-literal",
    "meaning": "The caller has left or the call has timed out.",
    "reason": "joinCall returns this message with status caller_gone. Preserve the response consumed by server-side calling tools."
  }
]
```

### Consumer evidence

- `app.js` passes MQTT `reason`/`message` values to devices and serializes the HTTP `error`/`message` values listed above. External clients may display or compare those values. This translation retains them without claiming that a consumer necessarily performs an exact-string match.
- In the sibling upstream repository, `main/manager-api/src/main/java/xiaozhi/modules/device/service/impl/DeviceAddressBookServiceImpl.java` calls `/api/call/request` and `/api/call/accept`. Its `postToMqtt` method copies the gateway's `status` and `message` into the tool result. Therefore the Chinese call-result messages remain user-language data as well as API compatibility values.
- `main/xiaozhi-server/core/handle/textHandler/listenMessageHandler.py` checks `original_text.startswith("[device_call]")`, removes that marker, then forwards the call text through `send_stt_message` and the TTS text path. Translating the incoming-call template would change spoken output. Its marker, interpolation expression, Chinese fallback, and language remain exact.
- Credential-validation exceptions and MQTT protocol-error exceptions translated here terminate or diagnose the local handshake/connection path. The application logs those events; they are not the preserved HTTP/MQTT message payloads listed above. No identifier or authentication decision changed.

## Verification

All checks ran offline against the original Git baseline:

- `node --check` passed for `app.js`, `mqtt-protocol.js`, `ecosystem.config.js`, and the three `utils/*.js` files. Syntax checking does not load these modules or start listeners.
- The sibling integration command `node --test ../upstream/tools/gateway-translation.test.mjs` passed all 7 tests. The suite never imports `app.js`; it checks its syntax/source and loads protocol/credential/call-manager modules in VM contexts with mock dependencies, sockets, clock, console, and environment.
- Differential tests cover Remaining Length boundaries, PUBLISH bytes and fragmented input, CONNACK/SUBACK/PINGRESP/disconnect behavior, HMAC inputs and generated credentials, IP normalization, call pairing/session cleanup/timeouts, UDP framing/crypto operations, route declarations, and unchanged package behavior outside `description`.
- A separate read-only comparison parsed all six JavaScript files with Node's bundled Acorn parser. It compared normalized ASTs and all 11,200 lexical tokens with the baseline. Only comments and 99 reviewed diagnostic string/template parts differ. Template interpolation expressions, identifiers, operators, numeric literals, regular expressions, public wire strings, and all other code tokens match.
- `git diff --check` passed. Package JSON parses; all keys except `description` match the baseline. The example configuration, PM2 configuration, license, and ignore rules remain byte-identical.

## Known limitations and pre-existing behavior

- This is static and mocked verification. It does not prove live MQTT/UDP connectivity, a device's remote wake-up behavior, native audio encoding, production authorization, or performance.
- The README's original status-query request uses `deviceIds`, but the current handler expects `clientIds`. The original example is preserved with an English correction note; runtime request handling is unchanged.
- Existing diagnostics can print credentials, tokens, or raw client payloads. Translation does not remove that logging or change its information content; review logging security in a separately authorized change.
- Existing handshake ordering, error handling, timer/state behavior, and authentication policy remain as implemented. Translation is not a security audit or protocol redesign.
- Do not change the retained Chinese messages merely to make a Unicode scan empty. A later localization change must coordinate spoken-language behavior and API/device consumers first.
