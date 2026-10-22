// Run: node --test tools/service-policy.test.js
// No dotenv, deployed configuration, keys, providers, or running services are read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const net = require('node:net');
const dgram = require('node:dgram');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const policy = require('../utils/service-policy');

const gatewayRoot = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(gatewayRoot, 'app.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(gatewayRoot, 'utils/config-manager.js'), 'utf8');
const fixtureConfig = () => ({
    production: { chat_servers: ['ws://voice:8000/xiaozhi/v1/'] },
    development: { chat_servers: ['ws://127.0.0.1:18000/xiaozhi/v1/'], mac_addresss: [] },
    debug: false
});
const plain = value => JSON.parse(JSON.stringify(value));

test('fixed MQTT envelope marker preserves the existing voice contract without arbitrary query destinations', () => {
    for (const base of ['ws://voice:8000/xiaozhi/v1/', 'ws://127.0.0.1:8000/xiaozhi/v1/',
        'wss://localhost:8000/xiaozhi/v1/', 'ws://[::1]:8000/xiaozhi/v1/']) {
        const target = base + '?from=mqtt_gateway';
        assert.equal(policy.validateVoiceUrl(target), target);
        assert.equal(policy.voiceSocketOptions(target, {}).followRedirects, false);
        for (const query of ['?from=mqtt_gateway&token=secret', '?from=other', '?from=mqtt_gateway#fragment',
            '?from=mqtt_gateway?from=mqtt_gateway', '?token=secret']) {
            assert.throws(() => policy.validateVoiceUrl(base + query), /VOICE_URL_POLICY_REJECTED/);
        }
    }
    assert.throws(() => policy.validateVoiceUrl('ws://unreviewed.invalid/xiaozhi/v1/?from=mqtt_gateway'), /VOICE_URL_POLICY_REJECTED/);
});

function managerFixture(initial = JSON.stringify(fixtureConfig())) {
    let candidate = initial;
    let watchCallback;
    const timers = [];
    const logs = [];
    const context = {
        module: { exports: {} }, __dirname: path.join(gatewayRoot, 'utils'),
        require: name => {
            if (name === 'fs') return {
                readFileSync: () => { if (candidate instanceof Error) throw candidate; return candidate; },
                watch: (_directory, callback) => { watchCallback = callback; }
            };
            if (name === 'path') return path;
            if (name === 'events') return EventEmitter;
            if (name === './service-policy') return policy;
            throw new Error('Unexpected fixture dependency');
        },
        console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
        setTimeout: callback => { timers.push(callback); return callback; },
        clearTimeout: callback => { const i = timers.indexOf(callback); if (i >= 0) timers.splice(i, 1); }
    };
    vm.runInNewContext(managerSource, context, { filename: 'config-manager.fixture.js' });
    return {
        create: () => new context.module.exports.ConfigManager('synthetic-only.json'),
        replace: value => { candidate = value; },
        changed: type => { watchCallback(type, 'synthetic-only.json'); },
        flush: () => { for (const callback of timers.splice(0)) callback(); },
        logs
    };
}

function gatewayFixture({ config = fixtureConfig(), env = {}, SocketClass } = {}) {
    const logs = [];
    const sockets = [];
    const listeners = [];
    const credentialCalls = [];
    const routes = new Map();
    class FakeSocket extends EventEmitter {
        static OPEN = 1;
        constructor(url, options) {
            super();
            this.url = url;
            this.options = options;
            this.readyState = 1;
            this.sent = [];
            sockets.push(this);
        }
        send(data, options) { this.sent.push({ data, options }); }
        close() { this.readyState = 3; }
    }
    class FakeProtocol extends EventEmitter {
        constructor() { super(); this.published = []; }
        sendPublish(...args) { this.published.push(args); }
        sendSuback() {}
        close() {}
    }
    class FakeConfig extends EventEmitter {
        get(name) { return config[name]; }
    }
    class FakeCallManager {
        clearDevice() { return {}; }
        getCallSessionId() {}
        isInCall() { return false; }
    }
    const debug = (...args) => logs.push(args);
    const debugModule = () => debug;
    debugModule.enable = debugModule.disable = () => {};
    const express = () => ({
        use() {},
        post: (route, ...handlers) => routes.set(route, handlers),
        listen: (port, callback) => { listeners.push(['api', port]); callback(); }
    });
    express.json = () => () => {};
    const context = {
        module: { exports: {} }, Buffer, URL,
        process: {
            env: { PUBLIC_IP: '127.0.0.1', SERVER_SECRET: 'synthetic-hmac-only',
                MQTT_SIGNATURE_KEY: 'FixtureOnlyStrongKey', ...env },
            on() {}, exit() { throw new Error('Unexpected fixture exit'); }
        },
        console: {
            log: (...args) => logs.push(args), warn: (...args) => logs.push(args),
            error: (...args) => logs.push(args)
        },
        setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
        require: name => {
            if (name === 'dotenv') return { config() {} };
            if (name === 'debug') return debugModule;
            if (name === 'crypto') return crypto;
            if (name === 'events') return EventEmitter;
            if (name === 'ws') return SocketClass || FakeSocket;
            if (name === 'net') return { createServer: () => ({
                listen: (port, callback) => { listeners.push(['mqtt', port]); callback(); }
            }) };
            if (name === 'dgram') return { createSocket: () => {
                const socket = new EventEmitter();
                socket.bind = (port, callback) => { listeners.push(['udp', port]); callback(); };
                return socket;
            } };
            if (name === 'express') return express;
            if (name === './mqtt-protocol') return { MQTTProtocol: FakeProtocol };
            if (name === './utils/config-manager') return { ConfigManager: FakeConfig };
            if (name === './utils/call-manager') return { CallManager: FakeCallManager };
            if (name === './utils/service-policy') return policy;
            if (name === './utils/mqtt_config_v2') return { validateMqttCredentials: (...args) => {
                credentialCalls.push(args);
                return { groupId: 'fixture', macAddress: 'aa:bb:cc:dd:ee:ff', uuid: 'fixture-uuid', userData: { ip: '127.0.0.1' } };
            } };
            throw new Error('Unexpected fixture dependency');
        }
    };
    vm.runInNewContext(appSource + '\nmodule.exports = { WebSocketBridge, MQTTConnection, MQTTServer, authenticateRequest, calculateDailyToken, server };', context,
        { filename: 'app.synthetic.fixture.js' });
    return { ...context.module.exports, sockets, listeners, logs, routes, credentialCalls };
}

test('policy accepts only exact approved voice and literal loopback destinations', () => {
    for (const url of ['ws://voice:8000/xiaozhi/v1/', 'ws://localhost:8000/xiaozhi/v1/',
        'wss://localhost/', 'ws://127.0.0.1:65535/', 'wss://[::1]:8443/xiaozhi/v1/']) {
        assert.equal(policy.validateVoiceUrl(url), url);
    }
});

test('policy rejects aliases, cloud/LAN, parser tricks, credentials, fragments, and queries', () => {
    const rejected = [null, {}, '', ' ws://localhost/', 'ws://localhost/\n',
        'http://localhost/', 'https://voice:8000/xiaozhi/v1/', 'ws+unix:///tmp/socket',
        'ws://mqtt.xiaozhi.me/', 'ws://192.168.1.10/', 'ws://10.0.0.1/', 'ws://172.18.0.2/',
        'ws://127.1/', 'ws://2130706433/', 'ws://0x7f000001/', 'ws://0177.0.0.1/',
        'ws://127.0.0.2/', 'ws://[::ffff:127.0.0.1]/', 'ws://[0:0:0:0:0:0:0:1]/',
        'ws://localhost./', 'ws://LOCALHOST/', 'ws://localhost.example/', 'ws://localtest.me/',
        'ws://user:synthetic-secret@localhost/', 'ws://localhost@cloud.example/',
        'ws://localhost%2eexample/', 'ws://%6cocalhost/', 'ws://localhost\\@cloud.example/',
        'ws://localhost/#synthetic-secret', 'ws://localhost/?token=synthetic-secret',
        'ws://localhost/?', 'ws://localhost/#', 'ws://localhost:0/', 'ws://localhost:65536/',
        'ws://localhost:08000/', 'wss://voice:8000/xiaozhi/v1/', 'ws://voice/xiaozhi/v1/',
        'ws://voice:8001/xiaozhi/v1/', 'ws://voice:8000/', 'ws://voice:8000/xiaozhi/v1',
        'ws://voice:8000/x/../xiaozhi/v1/', 'ws://voice:8000/xiaozhi/%76%31/',
        'ws://voice.:8000/xiaozhi/v1/', 'ws://voice:8000/xiaozhi/v1/?token=synthetic-secret'];
    for (const value of rejected) {
        assert.throws(() => policy.validateVoiceUrl(value), { message: 'VOICE_URL_POLICY_REJECTED' });
    }
});

test('PUBLIC_IP must be an explicit bare host and errors never echo its value', () => {
    for (const value of ['127.0.0.1', '::1', '192.168.1.50', 'gateway.example', 'localhost']) {
        assert.equal(policy.validatePublicIp(value), value);
    }
    for (const value of [undefined, null, '', ' ', 'http://synthetic-secret@host/',
        'host:1883', 'host/path', 'host?token=synthetic-secret', 'host#secret', 'host\n', '-host', 'host..example']) {
        assert.throws(() => policy.validatePublicIp(value), { message: 'PUBLIC_IP_REQUIRED_VALID_HOST' });
    }
    assert.throws(() => gatewayFixture({ env: { PUBLIC_IP: undefined } }), { message: 'PUBLIC_IP_REQUIRED_VALID_HOST' });
});

test('all configured pools validate before activation, including development', () => {
    for (const value of [{}, null, [], { production: { chat_servers: [] } },
        { production: { chat_servers: ['ws://localhost/', 'ws://cloud.example/'] } },
        { ...fixtureConfig(), development: { chat_servers: [] } },
        { ...fixtureConfig(), development: { chat_servers: ['ws://cloud.example/'] } },
        { ...fixtureConfig(), development: { chat_servers: ['ws://localhost/'], mac_addresss: 'not-an-array' } }]) {
        assert.throws(() => policy.validateServerPools(value));
    }
    assert.equal(policy.validateServerPools(fixtureConfig()).production.chat_servers.length, 1);
    assert.ok(policy.validateServerPools({ production: { chat_servers: ['ws://localhost/'] } }));
});

test('invalid reload preserves the last valid configuration and emits no change event', () => {
    const fixture = managerFixture();
    const manager = fixture.create();
    const original = manager.getConfig();
    let changed = 0;
    manager.on('configChanged', () => changed++);
    for (const candidate of [JSON.stringify({ production: { chat_servers: ['ws://user:synthetic-secret@cloud.example/'] } }),
        '{"apiKey":"synthetic-secret",', JSON.stringify({}), Object.assign(new Error('synthetic-secret'), { code: 'ENOENT' })]) {
        fixture.replace(candidate);
        assert.equal(manager.loadConfig(), false);
        assert.equal(manager.getConfig(), original);
        assert.equal(manager.isReady(), true);
        assert.equal(changed, 0);
    }
    assert.doesNotMatch(JSON.stringify(fixture.logs), /synthetic-secret|cloud\.example|apiKey|synthetic-only/);
    const next = fixtureConfig();
    next.production.chat_servers = ['wss://127.0.0.1:8443/'];
    fixture.replace(JSON.stringify(next));
    assert.equal(manager.loadConfig(), true);
    assert.equal(changed, 1);
    assert.deepEqual(plain(manager.getConfig()), next);
});

test('initial invalid or missing configuration is explicitly unready with no empty-file fallback', () => {
    for (const initial of ['{}', 'synthetic-secret-invalid-json',
        Object.assign(new Error('synthetic-secret'), { code: 'ENOENT' })]) {
        const fixture = managerFixture(initial);
        assert.throws(fixture.create, { message: 'GATEWAY_CONFIG_UNREADY' });
        assert.doesNotMatch(JSON.stringify(fixture.logs), /synthetic-secret|synthetic-only/);
    }
});

test('atomic rename reloads are debounced and rejected candidates do not replace routing', () => {
    const fixture = managerFixture();
    const manager = fixture.create();
    const original = manager.getConfig();
    fixture.replace('{}');
    fixture.changed('change');
    fixture.changed('rename');
    fixture.flush();
    assert.equal(manager.getConfig(), original);
    fixture.replace(JSON.stringify({ production: { chat_servers: ['ws://localhost:18001/'] } }));
    fixture.changed('rename');
    fixture.flush();
    assert.deepEqual(plain(manager.get('production').chat_servers), ['ws://localhost:18001/']);
});

test('connection options disable redirects/global proxy agents and pin localhost resolution', () => {
    const headers = { authorization: 'Bearer synthetic-only' };
    const options = policy.voiceSocketOptions('ws://localhost:18000/', headers);
    assert.equal(options.headers, headers);
    assert.equal(options.agent, false);
    assert.equal(options.followRedirects, false);
    options.lookup('localhost', {}, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, '127.0.0.1'); assert.equal(family, 4);
    });
    options.lookup('localhost', { all: true }, (error, addresses) => {
        assert.equal(error, null); assert.deepEqual(addresses, [{ address: '127.0.0.1', family: 4 }]);
    });
    assert.equal(policy.voiceSocketOptions('ws://voice:8000/xiaozhi/v1/', {}).lookup, undefined);
});

test('bridge revalidates immediately before WebSocket construction and redacts transport errors', async () => {
    const fixture = gatewayFixture();
    const bridge = new fixture.WebSocketBridge({}, 3, 'aa:bb:cc:dd:ee:ff', 'fixture-uuid');
    bridge.chatServer = 'ws://user:synthetic-secret@cloud.example/';
    await assert.rejects(bridge.connect({}, {}), { message: 'VOICE_CONNECTION_REJECTED' });
    assert.equal(fixture.sockets.length, 0);
    bridge.chatServer = 'ws://localhost:18000/';
    const connected = bridge.connect({}, {});
    fixture.sockets[0].emit('error', new Error('ws://user:synthetic-secret@cloud.example/'));
    await assert.rejects(connected, { message: 'VOICE_CONNECTION_FAILED' });
    assert.doesNotMatch(JSON.stringify(fixture.logs), /synthetic-secret|cloud\.example/);
});

test('synthetic protocol fixture preserves HMAC auth, v2 hello, JSON and binary WebSocket framing', async () => {
    const fixture = gatewayFixture();
    const mqtt = [];
    const udp = [];
    const connection = { sendMqttMessage: value => mqtt.push(value), sendUdpMessage: (...args) => udp.push(args) };
    const bridge = new fixture.WebSocketBridge(connection, 3, 'aa:bb:cc:dd:ee:ff', 'fixture-uuid', { ip: '127.0.0.1' });
    const audio = { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 };
    const features = { mcp: true };
    const connected = bridge.connect(audio, features);
    const socket = fixture.sockets[0];
    const headers = socket.options.headers;
    assert.equal(headers['device-id'], 'aa:bb:cc:dd:ee:ff');
    assert.equal(headers['protocol-version'], '2');
    assert.equal(headers['client-id'], 'fixture-uuid');
    assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    const [signature, timestamp] = headers.authorization.slice('Bearer '.length).split('.');
    assert.equal(signature, crypto.createHmac('sha256', 'synthetic-hmac-only')
        .update(`fixture-uuid|aa:bb:cc:dd:ee:ff|${timestamp}`).digest('base64url'));
    assert.equal(socket.options.followRedirects, false);
    assert.equal(socket.options.agent, false);
    socket.emit('open');
    assert.deepEqual(JSON.parse(socket.sent[0].data), { type: 'hello', version: 2, transport: 'websocket', audio_params: audio, features });
    const hello = { type: 'hello', session_id: 'synthetic-session', audio_params: audio };
    socket.emit('message', Buffer.from(JSON.stringify(hello)), false);
    assert.deepEqual(plain(await connected), hello);
    socket.emit('message', Buffer.from('{"type":"tts","state":"start"}'), false);
    assert.deepEqual(mqtt, ['{"type":"tts","state":"start"}']);
    const opus = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame = Buffer.alloc(16 + opus.length);
    frame.writeUInt32BE(1234, 8); frame.writeUInt32BE(opus.length, 12); frame.set(opus, 16);
    socket.emit('message', frame, true);
    assert.deepEqual(udp, [[opus, 1234]]);
    bridge.sendAudio(opus, 1234);
    assert.deepEqual(socket.sent[1].data, frame);
    assert.equal(socket.sent[1].options.binary, true);
    bridge.sendJson({ type: 'listen', state: 'start' });
    assert.deepEqual(JSON.parse(socket.sent[2].data), { type: 'listen', state: 'start' });
});

test('synthetic protocol fixture preserves MQTT auth, v3 UDP hello and AES-CTR audio round trip', async () => {
    const fixture = gatewayFixture();
    const server = fixture.server;
    const packets = [];
    server.sendUdpMessage = (...args) => packets.push(args);
    const connection = new fixture.MQTTConnection({ remoteAddress: '127.0.0.1' }, 42, server);
    connection.initializeDeviceTools = () => {};
    connection.handleConnect({ clientId: 'fixture@@@aa_bb_cc_dd_ee_ff@@@fixture-uuid', username: 'fixture-user', password: 'synthetic-password' });
    assert.deepEqual(fixture.credentialCalls[0], ['fixture@@@aa_bb_cc_dd_ee_ff@@@fixture-uuid', 'fixture-user', 'synthetic-password', '127.0.0.1']);
    const audio = { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 };
    const helloPending = connection.parseHelloMessage({ type: 'hello', version: 3, audio_params: audio, features: { mcp: true } });
    const socket = fixture.sockets[0];
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', session_id: 'synthetic-session', audio_params: audio })), false);
    await helloPending;
    const [topic, payload, qos, retain, dup] = connection.protocol.published[0];
    assert.equal(topic, 'devices/p2p/aa_bb_cc_dd_ee_ff');
    assert.deepEqual([qos, retain, dup], [0, false, false]);
    const hello = JSON.parse(payload);
    assert.equal(hello.version, 3); assert.equal(hello.transport, 'udp');
    assert.equal(hello.session_id, 'synthetic-session');
    assert.equal(hello.udp.server, '127.0.0.1'); assert.equal(hello.udp.port, 1883);
    assert.equal(hello.udp.encryption, 'aes-128-ctr');
    assert.equal(hello.udp.key.length, 32); assert.equal(hello.udp.nonce.length, 32);
    assert.deepEqual(hello.audio_params, audio);
    const opus = Buffer.from([1, 3, 5, 7, 9]);
    const key = Buffer.from(hello.udp.key, 'hex');
    const incomingHeader = connection.generateUdpHeader(opus.length, 4242, 1);
    const cipher = crypto.createCipheriv('aes-128-ctr', key, incomingHeader);
    const incoming = Buffer.concat([incomingHeader, cipher.update(opus), cipher.final()]);
    const remote = { address: '127.0.0.1', port: 19000 };
    server.onUdpMessage(incoming, remote);
    const wsAudio = socket.sent.at(-1);
    assert.equal(wsAudio.options.binary, true);
    assert.equal(wsAudio.data.readUInt32BE(8), 4242);
    assert.equal(wsAudio.data.readUInt32BE(12), opus.length);
    assert.deepEqual(wsAudio.data.subarray(16), opus);
    socket.emit('message', wsAudio.data, true);
    assert.equal(packets.length, 1); assert.equal(packets[0][1], remote);
    const [outgoing] = packets[0];
    assert.equal(outgoing.readUInt8(0), 1); assert.equal(outgoing.readUInt16BE(2), opus.length);
    assert.equal(outgoing.readUInt32BE(4), 42); assert.equal(outgoing.readUInt32BE(8), 4242);
    assert.equal(outgoing.readUInt32BE(12), 1);
    const decipher = crypto.createDecipheriv('aes-128-ctr', key, outgoing.subarray(0, 16));
    assert.deepEqual(Buffer.concat([decipher.update(outgoing.subarray(16)), decipher.final()]), opus);
    assert.doesNotMatch(JSON.stringify(fixture.logs), /synthetic-password|Bearer |ws:\/\//);
});

test('management API authentication still requires the existing daily bearer token', () => {
    const fixture = gatewayFixture();
    const statusCodes = [];
    let nextCalls = 0;
    const response = { status: code => { statusCodes.push(code); return response; }, json() {} };
    for (const authorization of [undefined, 'Basic synthetic', 'Bearer invalid']) {
        fixture.authenticateRequest({ headers: { authorization } }, response, () => nextCalls++);
    }
    fixture.authenticateRequest({ headers: { authorization: `Bearer ${fixture.calculateDailyToken()}` } }, response, () => nextCalls++);
    assert.deepEqual(statusCodes, [401, 401, 401]); assert.equal(nextCalls, 1);
    for (const handlers of fixture.routes.values()) assert.equal(handlers[0], fixture.authenticateRequest);
});

// Public wire contract exercised below (no firmware/provider required):
// MQTT 3.1.1, QoS 0; legacy client ID GID_fixture@@@aa_bb_cc_dd_ee_ff.
// Publish JSON to device-server; subscribe devices/p2p/aa_bb_cc_dd_ee_ff.
// Device hello: {type:'hello', version:3, audio_params:{format:'opus', ...}}.
// Reply includes UDP server/port, AES-128-CTR key and nonce in hex, session_id.
// UDP: type:u8=1, flags:u8=0, payloadLength:u16BE, connectionId:u32BE,
// timestamp:u32BE, sequence:u32BE, encrypted payload. The entire 16-byte header
// is the AES-CTR IV; derive connectionId from nonce bytes 4..7. Sequences increase.
// Voice WS receives a v2 websocket hello and the existing HMAC bearer header.
// WS binary: 8 reserved zero bytes, timestamp:u32BE, opusLength:u32BE, opus bytes.

async function wireChildBootstrap(root, voicePort) {
    const fs = require('node:fs');
    const path = require('node:path');
    const net = require('node:net');
    const dgram = require('node:dgram');
    const Module = require('node:module');
    const EventEmitter = require('node:events');
    // Allocate distinct ephemeral ports; never bind the application's defaults.
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const mqttPort = reservation.address().port;
    const udpReservation = dgram.createSocket('udp4');
    await new Promise(resolve => udpReservation.bind(0, '127.0.0.1', resolve));
    const udpPort = udpReservation.address().port;
    if (new Set([mqttPort, udpPort, voicePort]).size !== 3) throw new Error('FIXTURE_PORT_COLLISION');
    await new Promise(resolve => reservation.close(resolve));
    await new Promise(resolve => udpReservation.close(resolve));
    process.env.MQTT_PORT = String(mqttPort);
    process.env.UDP_PORT = String(udpPort);
    const configPath = path.join(root, 'config', 'mqtt.json');
    const syntheticConfig = JSON.stringify({ production: { chat_servers: [`ws://127.0.0.1:${voicePort}/xiaozhi/v1/`] }, debug: false });
    const originalRead = fs.readFileSync;
    function forbidden(file) {
        if (typeof file !== 'string' && !Buffer.isBuffer(file)) return false;
        const resolved = path.resolve(String(file));
        return /(?:^|\/)(?:\.env(?:\.[^/]*)?|gateway-config\.json|data|keys)(?:\/|$)/.test(resolved) ||
            resolved.startsWith(path.join(root, 'config') + path.sep);
    }
    fs.readFileSync = function(file, ...args) {
        if (String(file) === configPath) return syntheticConfig;
        if (forbidden(file)) throw new Error('FIXTURE_FORBIDS_DEPLOYED_CONFIG');
        return originalRead.call(this, file, ...args);
    };
    // No deployed config watcher or file reads/writes; ConfigManager still runs
    // its actual parsing, candidate validation, and activation code.
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
        if ((request === 'fs' || request === 'node:fs') && parent &&
            parent.filename === path.join(root, 'utils', 'config-manager.js')) {
            return { readFileSync: fs.readFileSync, watch: () => new EventEmitter() };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let mqttReady = false;
    let udpReady = false;
    const ready = () => {
        if (mqttReady && udpReady) process.send({ type: 'fixture-ready', mqttPort, udpPort });
    };
    const originalCreateServer = net.createServer;
    net.createServer = function(...args) {
        const server = originalCreateServer.apply(this, args);
        const listen = server.listen;
        server.listen = function(port, callback) {
            if (Number(port) !== mqttPort) throw new Error('FIXTURE_UNEXPECTED_TCP_LISTENER');
            server.once('listening', () => { mqttReady = true; ready(); });
            return listen.call(this, port, '127.0.0.1', callback);
        };
        return server;
    };
    const originalCreateSocket = dgram.createSocket;
    dgram.createSocket = function(...args) {
        const socket = originalCreateSocket.apply(this, args);
        const bind = socket.bind;
        socket.bind = function(port, callback) {
            if (Number(port) !== udpPort) throw new Error('FIXTURE_UNEXPECTED_UDP_LISTENER');
            socket.once('listening', () => { udpReady = true; ready(); });
            return bind.call(this, port, '127.0.0.1', callback);
        };
        return socket;
    };
    require(path.join(root, 'app.js'));
}

function mqttString(value) {
    const text = Buffer.from(value);
    const prefix = Buffer.alloc(2); prefix.writeUInt16BE(text.length);
    return Buffer.concat([prefix, text]);
}

function mqttPacket(header, payload) {
    const length = [];
    let remaining = payload.length;
    do {
        let byte = remaining % 128;
        remaining = Math.floor(remaining / 128);
        if (remaining) byte |= 128;
        length.push(byte);
    } while (remaining);
    return Buffer.concat([Buffer.from([header, ...length]), payload]);
}

function mqttWireClient(socket) {
    let buffered = Buffer.alloc(0);
    const queued = [];
    const waiters = [];
    const deliver = packet => {
        const index = waiters.findIndex(waiter => waiter.predicate(packet));
        if (index < 0) queued.push(packet);
        else waiters.splice(index, 1)[0].resolve(packet);
    };
    socket.on('data', data => {
        buffered = Buffer.concat([buffered, data]);
        while (buffered.length >= 2) {
            let length = 0;
            let multiplier = 1;
            let offset = 1;
            let byte;
            do {
                if (offset >= buffered.length) return;
                byte = buffered[offset++];
                length += (byte & 127) * multiplier;
                multiplier *= 128;
            } while (byte & 128);
            if (buffered.length < offset + length) return;
            const packet = { type: buffered[0] >> 4, header: buffered[0], body: buffered.subarray(offset, offset + length) };
            buffered = buffered.subarray(offset + length);
            if (packet.type === 3) {
                const topicLength = packet.body.readUInt16BE(0);
                packet.topic = packet.body.subarray(2, 2 + topicLength).toString();
                packet.message = JSON.parse(packet.body.subarray(2 + topicLength).toString());
            }
            deliver(packet);
        }
    });
    return {
        next: predicate => new Promise((resolve, reject) => {
            const queuedIndex = queued.findIndex(predicate);
            if (queuedIndex >= 0) { resolve(queued.splice(queuedIndex, 1)[0]); return; }
            const waiter = { predicate, resolve: value => { clearTimeout(timer); resolve(value); } };
            const timer = setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                reject(new Error('FIXTURE_MQTT_PACKET_TIMEOUT'));
            }, 5000);
            waiters.push(waiter);
        }),
        publish: message => socket.write(mqttPacket(0x30, Buffer.concat([mqttString('device-server'), Buffer.from(JSON.stringify(message))])))
    };
}

test('wire child: real MQTT CONNECT/CONNACK, local voice WebSocket and UDP AES/header round trip', { timeout: 20000 }, async t => {
    // Dependency resolution is normal npm resolution; no deployed configuration
    // or env is inherited. npm ci --ignore-scripts is sufficient setup.
    const WebSocket = require('ws');
    const voice = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0, path: '/xiaozhi/v1/' });
    t.after(() => { for (const client of voice.clients) client.terminate(); return new Promise(resolve => voice.close(resolve)); });
    await once(voice, 'listening');
    const voicePort = voice.address().port;
    const audio = { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 };
    let receivedHeaders;
    let receivedHello;
    let receivedFrame;
    const frameReceived = new Promise(resolve => {
        voice.on('connection', (ws, request) => {
            receivedHeaders = request.headers;
            ws.on('message', (data, binary) => {
                if (binary) {
                    receivedFrame = Buffer.from(data);
                    ws.send(data, { binary: true });
                    resolve();
                } else {
                    const message = JSON.parse(data.toString());
                    if (message.type === 'hello') {
                        receivedHello = message;
                        ws.send(JSON.stringify({ type: 'hello', session_id: 'wire-synthetic-session', audio_params: audio }));
                    }
                }
            });
        });
    });
    const script = `(${wireChildBootstrap.toString()})(${JSON.stringify(gatewayRoot)}, ${voicePort}).catch(() => { process.send({type:'fixture-failed'}); process.exit(1); });`;
    const child = spawn(process.execPath, ['-e', script], {
        cwd: require('node:os').tmpdir(),
        env: { PUBLIC_IP: '127.0.0.1', SERVER_SECRET: 'wire-synthetic-hmac',
            MQTT_SIGNATURE_KEY: '', ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    });
    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('FIXTURE_CHILD_READY_TIMEOUT')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('FIXTURE_CHILD_EARLY_EXIT')); });
        child.on('message', message => {
            clearTimeout(timer);
            if (message.type === 'fixture-ready') resolve(message);
            else reject(new Error('FIXTURE_CHILD_STARTUP_FAILED'));
        });
    });
    assert.equal(new Set([ready.mqttPort, ready.udpPort, voicePort]).size, 3);
    const mqttSocket = net.connect({ host: '127.0.0.1', port: ready.mqttPort });
    t.after(() => mqttSocket.destroy());
    await once(mqttSocket, 'connect');
    const mqtt = mqttWireClient(mqttSocket);
    const connectBody = Buffer.concat([mqttString('MQTT'), Buffer.from([4, 0xc2, 0, 60]),
        mqttString('GID_fixture@@@aa_bb_cc_dd_ee_ff'), mqttString('wire-user'), mqttString('wire-password')]);
    mqttSocket.write(mqttPacket(0x10, connectBody));
    const connack = await mqtt.next(packet => packet.type === 2);
    assert.deepEqual(connack.body, Buffer.from([0, 0]));
    const replyTopic = 'devices/p2p/aa_bb_cc_dd_ee_ff';
    mqttSocket.write(mqttPacket(0x82, Buffer.concat([Buffer.from([0, 1]), mqttString(replyTopic), Buffer.from([0])])));
    assert.deepEqual((await mqtt.next(packet => packet.type === 9)).body, Buffer.from([0, 1, 0]));
    mqtt.publish({ type: 'hello', version: 3, audio_params: audio, features: { mcp: true } });
    const helloPacket = await mqtt.next(packet => packet.type === 3 && packet.message.type === 'hello');
    assert.equal(helloPacket.topic, replyTopic); assert.equal(helloPacket.header, 0x30);
    const hello = helloPacket.message;
    assert.equal(hello.version, 3); assert.equal(hello.transport, 'udp');
    assert.equal(hello.session_id, 'wire-synthetic-session');
    assert.equal(hello.udp.server, '127.0.0.1'); assert.equal(hello.udp.port, ready.udpPort);
    assert.equal(hello.udp.encryption, 'aes-128-ctr');
    assert.deepEqual(receivedHello, { type: 'hello', version: 2, transport: 'websocket', audio_params: audio, features: { mcp: true } });
    assert.equal(receivedHeaders['device-id'], 'aa:bb:cc:dd:ee:ff');
    assert.equal(receivedHeaders['protocol-version'], '2');
    const [signature, timestamp] = receivedHeaders.authorization.slice('Bearer '.length).split('.');
    assert.equal(signature, crypto.createHmac('sha256', 'wire-synthetic-hmac')
        .update(`default-client-id|aa:bb:cc:dd:ee:ff|${timestamp}`).digest('base64url'));
    const udp = dgram.createSocket('udp4');
    t.after(() => udp.close());
    await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
    const opus = Buffer.from([0x51, 0x52, 0x53, 0x54, 0x55]);
    const nonce = Buffer.from(hello.udp.nonce, 'hex');
    const key = Buffer.from(hello.udp.key, 'hex');
    assert.equal(nonce.length, 16); assert.equal(key.length, 16);
    const header = Buffer.from(nonce);
    header.writeUInt16BE(opus.length, 2); header.writeUInt32BE(424242, 8); header.writeUInt32BE(1, 12);
    const cipher = crypto.createCipheriv('aes-128-ctr', key, header);
    const outgoing = Buffer.concat([header, cipher.update(opus), cipher.final()]);
    const received = once(udp, 'message');
    udp.send(outgoing, ready.udpPort, '127.0.0.1');
    const [reply, remote] = await received;
    await frameReceived;
    assert.equal(remote.address, '127.0.0.1'); assert.equal(remote.port, ready.udpPort);
    assert.deepEqual(receivedFrame.subarray(0, 8), Buffer.alloc(8));
    assert.equal(receivedFrame.readUInt32BE(8), 424242);
    assert.equal(receivedFrame.readUInt32BE(12), opus.length);
    assert.deepEqual(receivedFrame.subarray(16), opus);
    assert.equal(reply.readUInt8(0), 1); assert.equal(reply.readUInt8(1), 0);
    assert.equal(reply.readUInt16BE(2), opus.length);
    assert.equal(reply.readUInt32BE(4), nonce.readUInt32BE(4));
    assert.equal(reply.readUInt32BE(8), 424242); assert.equal(reply.readUInt32BE(12), 1);
    const decipher = crypto.createDecipheriv('aes-128-ctr', key, reply.subarray(0, 16));
    assert.deepEqual(Buffer.concat([decipher.update(reply.subarray(16)), decipher.final()]), opus);
    assert.doesNotMatch(output, /wire-password|wire-synthetic-hmac|Bearer |ws:\/\//);
});

test('wire transport: redirects and environment/global proxy agents cannot bypass direct policy', { timeout: 10000 }, async t => {
    const WebSocket = require('ws');
    let sinkRequests = 0;
    let originRequests = 0;
    const sink = http.createServer((_request, response) => { sinkRequests++; response.writeHead(502).end(); });
    sink.on('upgrade', (_request, socket) => { sinkRequests++; socket.destroy(); });
    sink.on('connect', (_request, socket) => { sinkRequests++; socket.destroy(); });
    t.after(() => new Promise(resolve => sink.close(resolve)));
    await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
    const sinkPort = sink.address().port;
    const origin = http.createServer();
    origin.on('upgrade', (_request, socket) => {
        originRequests++;
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${sinkPort}/?token=synthetic-only\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    t.after(() => new Promise(resolve => origin.close(resolve)));
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    const envNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
    const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
    for (const name of envNames) process.env[name] = name.toLowerCase() === 'no_proxy' ? '' : `http://127.0.0.1:${sinkPort}`;
    const previousAgent = http.globalAgent;
    const trapAgent = new http.Agent();
    let globalAgentRequests = 0;
    trapAgent.addRequest = () => { globalAgentRequests++; throw new Error('FIXTURE_GLOBAL_PROXY_USED'); };
    http.globalAgent = trapAgent;
    t.after(() => {
        http.globalAgent = previousAgent; trapAgent.destroy();
        for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    });
    const url = `ws://localhost:${origin.address().port}/xiaozhi/v1/`;
    const ws = new WebSocket(url, policy.voiceSocketOptions(url, { authorization: 'Bearer synthetic-only' }));
    t.after(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); });
    const [error] = await once(ws, 'error');
    assert.match(error.message, /302/);
    assert.equal(originRequests, 1);
    assert.equal(sinkRequests, 0);
    assert.equal(globalAgentRequests, 0);
});
