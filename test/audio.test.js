// 音频编解码测试：与 Rust SDK src/audio.rs 的 #[cfg(test)] 用例对齐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpusCodec, RecordingAssembler, FRAME_SAMPLES, U32_MAX, checkLength } from '../src/audio.js';
import { ZectrixError } from '../src/packet.js';

const codec = new OpusCodec();

test('PCM → Opus 分帧：960 样本/帧，每帧 ≤1180 字节', () => {
  const samples = new Int16Array(1083);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.2) * 8000);
  const frames = codec.encode(samples);
  assert.equal(frames.length, 2);
  for (const f of frames) assert.ok(f.length > 0 && f.length <= 1180);
});

test('乱序帧 + 部分尾帧重组（与 Rust reordered_audio_and_partial_tail 一致）', () => {
  const samples = new Int16Array(1083);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i * 0.2) * 8000);
  const frames = codec.encode(samples);
  const rec = new RecordingAssembler(9, codec);
  rec.push(1, frames[1]);
  rec.push(0, frames[0]);
  rec.ending(2, 123, 'Completed');
  rec.drain(false);
  const { audio, reason } = rec.finish('Failed');
  assert.equal(reason, 'Completed');
  assert.equal(audio.length, 1083);
  // Opus 有损且带编解码延迟，不逐点比对；确认非静音、能量守恒
  let energy = 0;
  for (const v of audio) energy += v * v;
  assert.ok(Math.sqrt(energy / audio.length) > 1000, '解码结果不应为静音');
});

test('丢帧隐藏补偿（与 Rust missing_frame_is_concealed_at_end 一致）', () => {
  const samples = new Int16Array(1920).fill(300);
  const frames = codec.encode(samples);
  const rec = new RecordingAssembler(1, codec);
  rec.push(1, frames[1]); // 帧 0 丢失
  rec.ending(2, 960, 'Completed');
  const { audio } = rec.finish('Failed');
  assert.equal(audio.length, 1920);
  assert.equal(audio[0], 0); // 丢包补偿为静音
});

test('零帧录音不生成音频（与 Rust zero_frame_has_no_audio 一致）', () => {
  const rec = new RecordingAssembler(1, codec);
  rec.ending(0, 0, 'Completed');
  rec.drain(true);
  const { audio } = rec.finish('Failed');
  assert.equal(audio, null);
});

test('扩展音频：181 秒（超过旧 120 秒上限）现在通过编码', () => {
  // SDK 0.2.0 去掉 120 秒硬上限，不再以时长拒绝播放片段
  assert.doesNotThrow(() => codec.encode(new Int16Array(16000 * 181 + 123)));
});

test('checkLength：u32 帧数上限校验（SDK 0.2.0）', () => {
  assert.doesNotThrow(() => checkLength(16000 * 181 + 123)); // 181s 没问题
  assert.doesNotThrow(() => checkLength(U32_MAX * FRAME_SAMPLES)); // 恰好 u32 帧：允许
  assert.throws(
    () => checkLength(U32_MAX * FRAME_SAMPLES + 1),
    (e) => e instanceof ZectrixError && e.kind === 'AudioTooLong',
  );
});

test('三分钟录音（>2000 帧）完整重组（SDK 0.2.0 扩展音频）', () => {
  const samples = 16000 * 181 + 123;
  const frames = codec.encode(new Int16Array(samples).fill(300));
  assert.ok(frames.length > 2000, '应超过旧 2000 帧上限');
  const rec = new RecordingAssembler(7, codec);
  for (let i = 0; i < frames.length; i++) rec.push(i, frames[i]);
  rec.ending(frames.length, ((samples - 1) % FRAME_SAMPLES) + 1, 'Completed');
  assert.ok(rec.complete);
  const { audio, reason } = rec.finish('Failed');
  assert.equal(reason, 'Completed');
  assert.equal(audio.length, samples);
});

test('push 接受 6 帧窗口内的帧、丢弃 U32_MAX 帧（旧 2000 上限已取消）', () => {
  const rec = new RecordingAssembler(3, codec);
  const frame = codec.encode(new Int16Array(FRAME_SAMPLES).fill(100))[0];
  rec.push(0, frame); // 收一帧后 next=1
  assert.equal(rec.push(5, frame), true, '6 帧窗口内（5-1=4<6）应接受');
  assert.equal(rec.push(0xffffffff, frame), false, 'U32_MAX 帧没有可表示的结束号，应丢弃');
});

test('伪造 END 不能在收尾窗口外合成无限 PLC（SDK 0.2.0 防护）', () => {
  const rec = new RecordingAssembler(4, codec);
  const frame = codec.encode(new Int16Array(FRAME_SAMPLES).fill(100))[0];
  rec.push(0, frame); // 收一帧后 next=1
  // total=2000 与 next=1 相差远超 6 帧窗口，应被拒绝
  assert.throws(
    () => rec.ending(2000, 960, 'Completed'),
    (e) => e instanceof ZectrixError && e.kind === 'InvalidAudio',
  );
  // 合法收尾：total 在 6 帧窗口内
  assert.doesNotThrow(() => rec.ending(2, 960, 'Completed'));
});

test('Opus 编解码往返：960 样本帧长守恒', () => {
  const pcm = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin((i / FRAME_SAMPLES) * Math.PI * 8) * 10000);
  const [frame] = codec.encode(pcm);
  const back = codec.decode(frame);
  assert.equal(back.length, FRAME_SAMPLES);
});
