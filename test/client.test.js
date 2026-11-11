// 客户端集成测试：MockDevice 实现协议另一端，验证完整业务流程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import sharp from 'sharp';
import { MockDevice } from './mock-device.js';
import { ZectrixClient, ConnectionRequestListener } from '../src/client.js';
import { FORMAT } from '../src/image.js';
import { KEY, ACTION, END, T, encodePacket } from '../src/packet.js';
import { OpusCodec } from '../src/audio.js';

async function testPng() {
  const raw = Buffer.alloc(400 * 300 * 3);
  for (let i = 0; i < 400 * 300; i++) {
    raw[i * 3] = 60; raw[i * 3 + 1] = 120; raw[i * 3 + 2] = 200;
  }
  return sharp(raw, { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer();
}

test('完整连接握手：INFO → CONNECT → PALETTE', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`, { clientName: '测试NAS' });
  try {
    await client.open();
    assert.equal(client.summary.id, 'aabbccddeeff');
    assert.equal(client.summary.model, 'zectrix-s3-epaper-4.2');
    assert.deepEqual(client.palette.gray4, [0, 85, 170, 255]);
    assert.equal(client.connection > 0n, true);
  } finally {
    await client.close();
    device.stop();
  }
});

test('STATUS 查询', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    const status = await client.status();
    assert.deepEqual(status, { batteryPercent: 87, charging: true, wifiRssiDbm: -45 });
  } finally {
    await client.close();
    device.stop();
  }
});

test('图片推送：丢块补传 + IMAGE_STATUS 位图 + RESULT 确认', { timeout: 20000 }, async () => {
  const device = new MockDevice({ dropChunkOnce: true });
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    const png = await testPng();
    const started = Date.now();
    await client.show(png, FORMAT.GRAY4);
    assert.ok(Date.now() - started < 10000, '推送应在 10 秒内完成');
    // 模拟设备确认收到了完整图片（含被补传的块 0）
    const image = [...device.images.values()][0];
    assert.ok(image, '设备应收到 IMAGE_BEGIN');
    assert.ok(image.chunks.has(0), '被丢弃的块 0 应被补传');
    const expectedChunks = Math.ceil(image.totalLen / 1024);
    assert.equal(image.chunks.size, expectedChunks, `应收到全部 ${expectedChunks} 块，实际 ${image.chunks.size}`);
  } finally {
    await client.close();
    device.stop();
  }
});

test('按键事件经 ACK + 去重后交付', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  try {
    await client.open();
    const eventPromise = client.nextEvent();
    device.sendKey(KEY.CONFIRM, ACTION.SHORT);
    const event = await eventPromise;
    assert.deepEqual(event, { type: 'key', key: 'confirm', action: 'short' });
  } finally {
    await client.close();
    device.stop();
  }
});

test('设备录音上行：重组为完整 PCM', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  try {
    await client.open();
    const samples = new Int16Array(1500);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.3) * 9000);
    const frames = codec.encode(samples); // 2 帧
    const started = client.nextEvent();
    const finished = client.nextEvent();
    await device.sendRecording(42, frames, 540, END.NORMAL);
    const first = await started;
    assert.equal(first.type, 'recordingStarted');
    const second = await finished;
    assert.equal(second.type, 'recordingFinished');
    assert.equal(second.audio.length, 1500, `重组样本数应为 1500，实际 ${second.audio.length}`);
    assert.equal(second.reason, 'Completed');
  } finally {
    await client.close();
    device.stop();
  }
});

test('音频播放：AUDIO_BEGIN/DATA/END + RESULT 结束', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  const codec = new OpusCodec();
  try {
    await client.open();
    const samples = new Int16Array(4800); // 300ms
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.1) * 6000);
    const result = await client.play(samples, 70, codec);
    assert.equal(result.end, 'Completed');
    const stream = [...device.streams.values()][0];
    assert.ok(stream && stream.frames.size === 5, `设备应收到 5 帧，实际 ${stream?.frames.size}`);
  } finally {
    await client.close();
    device.stop();
  }
});

test('设备主动 CLOSE：客户端进入终态并交付 disconnected', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const client = new ZectrixClient(`127.0.0.1:${port}`);
  await client.open();
  const eventPromise = client.nextEvent();
  // 模拟设备长按退出：发送 CLOSE（原因 1=设备主动退出）
  device.socket.send(
    (await import('../src/packet.js')).encodePacket(4, device.connectionId, 5, Buffer.from([END.DEVICE_EXIT])),
    device._lastClientPort,
    '127.0.0.1',
  );
  const event = await eventPromise;
  assert.equal(event.type, 'disconnected');
  assert.equal(event.reason, 'DeviceExit');
  assert.equal(client.closed, true);
  device.stop();
});

test('open_requested：按设备给定连接号回连并校验', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  try {
    const client = new ZectrixClient(`127.0.0.1:${port}`, { clientName: '测试NAS' });
    await client.open_requested(device.connectionId); // 0x1234n
    assert.equal(client.summary.id, 'aabbccddeeff');
    assert.equal(client.palette.gray16.length, 16);
    assert.equal(client.connection, device.connectionId);
    await client.close();

    // 连接号不匹配应失败（避免连上已易主的设备）
    const bad = new ZectrixClient(`127.0.0.1:${port}`, { clientName: '测试NAS' });
    await assert.rejects(() => bad.open_requested(0x9999n), (e) => e.kind === 'Disconnected');
  } finally {
    device.stop();
  }
});

test('open_requested：管理端名称校验（1~48 字节、无控制字符）', async () => {
  const device = new MockDevice();
  const port = await device.start();
  try {
    const client = new ZectrixClient(`127.0.0.1:${port}`);
    await assert.rejects(
      () => client.open_requested(0x1234n, 'x'.repeat(49)),
      (e) => e.kind === 'InvalidOptions',
    );
  } finally {
    device.stop();
  }
});

test('open_requested：忙碌设备返回 Busy', { timeout: 20000 }, async () => {
  const device = new MockDevice({ busy: true });
  const port = await device.start();
  try {
    const client = new ZectrixClient(`127.0.0.1:${port}`, { clientName: '测试NAS' });
    await assert.rejects(() => client.open_requested(0x1234n), (e) => e.kind === 'Busy');
  } finally {
    device.stop();
  }
});

test('ConnectionRequestListener：过滤非法包、去重、返回合法请求', { timeout: 20000 }, async () => {
  const listener = new ConnectionRequestListener();
  await listener.bind();
  let sock;
  try {
    sock = dgram.createSocket('udp4');
    const send = (buf) =>
      new Promise((r) => sock.send(buf, 0, buf.length, ConnectionRequestListener.PORT, '127.0.0.1', r));
    // 先发一个非法包（错误类型），应被忽略
    await send(encodePacket(T.INFO, 0x1234n, 1));
    // 再发合法 CONNECT_REQUEST
    await send(encodePacket(T.CONNECT_REQUEST, 0x1234n, 1));
    const req = await listener.nextRequest();
    assert.equal(req.connectionId, 0x1234n);
    assert.ok(req.address.startsWith('127.0.0.1:'), `地址应为 127.0.0.1:port，实际 ${req.address}`);
    // 同一条请求（相同地址+连接号）应被去重：紧接着重发一次再发一条新连接号，
    // 单一消费者的 nextRequest 应跳过重复、只交付新连接号（避免并发抢包导致的竞态）
    await send(encodePacket(T.CONNECT_REQUEST, 0x1234n, 1));
    await send(encodePacket(T.CONNECT_REQUEST, 0x5678n, 1));
    const req2 = await listener.nextRequest();
    assert.equal(req2.connectionId, 0x5678n, '应跳过重复请求并交付新连接号');
  } finally {
    listener.close();
    if (sock) sock.close();
  }
});

test('设备主动连接端到端：监听器收到请求 → 回连 MockDevice', { timeout: 20000 }, async () => {
  const device = new MockDevice();
  const port = await device.start();
  const listener = new ConnectionRequestListener();
  await listener.bind();
  try {
    // 设备用自身套接字向监听端口发 CONNECT_REQUEST（连接号用 MockDevice 的当前值）
    device.sendConnectRequest(ConnectionRequestListener.PORT);
    const req = await listener.nextRequest();
    // req.address 应为设备真实地址:端口，回连后握手成功
    assert.equal(req.connectionId, device.connectionId);
    const client = await req.accept('测试NAS');
    assert.equal(client.summary.id, 'aabbccddeeff');
    assert.equal(client.connection, device.connectionId);
    await client.close();
  } finally {
    listener.close();
    device.stop();
  }
});
