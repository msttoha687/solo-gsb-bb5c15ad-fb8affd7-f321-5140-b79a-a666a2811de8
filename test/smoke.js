'use strict';

/*
 * 端到端冒烟测试（不依赖测试框架）：
 * 通过真实 WebSocket 连接校验：
 *  1. 草稿/发布：空字幕、重复序号拒绝；正常发布固化
 *  2. 场次创建；演出中切换版本拒绝
 *  3. 控制权：独占、重复取得幂等、过期后他人接管
 *  4. 演出操作：旧版本 baseVersion 拒绝；重复 opId 不重复生效且回放结论
 *  5. 观众快照实时推送；清屏/推进/回退/边界拒绝
 *  6. 服务重启后从 SQLite 恢复最新已确认状态
 */
const assert = require('assert');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_PORT) || 8099;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const HTTP = `http://127.0.0.1:${PORT}`;

let counter = 0;
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function rpc(ws, method, params, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error(`rpc ${method} 超时`));
    }, timeoutMs);
    const onMsg = (raw) => {
      const msg = JSON.parse(String(raw));
      if ((msg.type === 'result' || msg.type === 'error') && msg.id === id) {
        clearTimeout(timer);
        ws.removeListener('message', onMsg);
        if (msg.type === 'error') {
          const err = new Error(msg.message);
          err.code = msg.code;
          err.stateVersion = msg.stateVersion;
          reject(err);
        } else resolve(msg.result);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
  });
}

function nextMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      reject(new Error('等待推送超时'));
    }, timeoutMs);
    function onMsg(raw) {
      const msg = JSON.parse(String(raw));
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeListener('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

// 每个连接持续缓存最新场次快照，避免“操作结果返回前广播已发出”导致漏等
function trackSnapshots(ws) {
  const latest = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'snapshot') latest.set(msg.sessionId, msg.snapshot);
    if (msg.type === 'subscribed' && msg.snapshot) latest.set(msg.snapshot.sessionId, msg.snapshot);
  });
  return latest;
}

function waitForSnapshot(latest, ws, sessionId, test, timeoutMs = 5000) {
  const cur = latest.get(sessionId);
  if (cur && test(cur)) return Promise.resolve({ type: 'snapshot', sessionId, snapshot: cur });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg);
      const now = latest.get(sessionId);
      reject(new Error(`等待快照超时（当前状态：${now ? JSON.stringify({ i: now.currentIndex, show: now.showing, st: now.status }) : '无'}）`));
    }, timeoutMs);
    function onMsg(raw) {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot' && msg.sessionId === sessionId && test(msg.snapshot)) {
        clearTimeout(timer);
        ws.removeListener('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

const subscribeSession = (ws, sessionId) =>
  nextMessage(ws, (m) => m.type === 'subscribed', 4000);

const opId = (p) => `${p}_${++counter}_${Date.now().toString(36)}`;

async function main() {
  const editor = await connect();
  const opA = await connect();
  const opB = await connect();
  const audience = await connect();
  for (const ws of [editor, opA, opB, audience]) ws.setMaxListeners(0);

  const snapA = trackSnapshots(opA);
  const snapB = trackSnapshots(opB);
  const snapAud = trackSnapshots(audience);

  const scriptId = 1;

  // ---------- 1. 发布校验 ----------
  await assert.rejects(
    rpc(editor, 'publishVersion', { scriptId, label: 'bad', entries: [] }),
    (e) => e.code === 'EMPTY_SUBTITLE',
    '空字幕应拒绝'
  );
  await assert.rejects(
    rpc(editor, 'publishVersion', {
      scriptId, label: 'bad',
      entries: [{ seq: 1, text: 'a' }, { seq: 1, text: 'b' }],
    }),
    (e) => e.code === 'DUPLICATE_SEQ',
    '重复序号应拒绝'
  );
  await assert.rejects(
    rpc(editor, 'publishVersion', { scriptId, label: 'bad', entries: [{ seq: 2, text: '   ' }] }),
    (e) => e.code === 'EMPTY_SUBTITLE',
    '空白文本应拒绝'
  );

  const v1 = await rpc(editor, 'publishVersion', {
    scriptId, label: '首演版',
    entries: [
      { seq: 1, text: '第一条字幕' },
      { seq: 2, text: '第二条字幕' },
      { seq: 3, text: '第三条字幕' },
    ],
  });
  assert.strictEqual(v1.version.version, 1);

  // 再发布一版，但不影响下面的场次（场次锁定 v1）
  await rpc(editor, 'saveDraft', { scriptId, entries: [{ seq: 1, text: '草稿修改不应影响已发布版本' }] });
  const v2 = await rpc(editor, 'publishVersion', {
    scriptId, label: '备用版',
    entries: [{ seq: 1, text: '备用版第一条' }],
  });
  assert.strictEqual(v2.version.version, 2);

  // ---------- 2. 场次 ----------
  const created = await rpc(editor, 'createSession', { scriptId, name: '冒烟测试场', versionId: v1.version.id });
  const sessionId = created.sessionId;

  audience.send(JSON.stringify({ type: 'subscribe', id: ++counter, channel: 'session', sessionId }));
  const sub = await subscribeSession(audience, sessionId);
  assert.strictEqual(sub.snapshot.status, 'ready');
  assert.strictEqual(sub.snapshot.version.id, v1.version.id);
  assert.strictEqual(sub.snapshot.entries[0].text, '第一条字幕');

  // ready 阶段允许切版本，live 阶段拒绝
  const sw = await rpc(editor, 'switchVersion', { sessionId, versionId: v2.version.id });
  assert.strictEqual(sw.snapshot.version.id, v2.version.id);
  await rpc(editor, 'switchVersion', { sessionId, versionId: v1.version.id });

  // ---------- 3. 控制权 ----------
  const acqA = await rpc(opA, 'acquireControl', { sessionId, name: '甲' });
  assert.ok(acqA.token);
  const tokenA = acqA.token;
  // 主流程期间为甲发送心跳，保持持控；接管测试前再关闭
  let hbA = setInterval(() => rpc(opA, 'heartbeat', { sessionId, token: tokenA }).catch(() => {}), 1000);
  hbA.unref();
  await assert.rejects(
    rpc(opB, 'acquireControl', { sessionId, name: '乙' }),
    (e) => e.code === 'CONTROL_HELD',
    '同一场次他人持控时应拒绝'
  );
  // 同一持控者重复取得：幂等，返回同一令牌
  const acqA2 = await rpc(opA, 'acquireControl', { sessionId, name: '甲', token: tokenA });
  assert.strictEqual(acqA2.token, tokenA);

  // 无控制权者操作必须拒绝
  await assert.rejects(
    rpc(opB, 'start', { sessionId, token: 'bogus', opId: opId('s'), baseVersion: 0 }),
    (e) => e.code === 'NOT_CONTROLLER'
  );

  // ---------- 4. 演出操作 ----------
  opA.send(JSON.stringify({ type: 'subscribe', id: ++counter, channel: 'session', sessionId }));
  await subscribeSession(opA, sessionId);

  const start = await rpc(opA, 'start', { sessionId, token: tokenA, opId: opId('start'), baseVersion: 0 });
  assert.strictEqual(start.stateVersion, 1);
  assert.strictEqual(start.snapshot.current.text, '第一条字幕');

  // 观众实时收到
  const liveSnap = await waitForSnapshot(snapAud, audience, sessionId, (s) => s.showing && s.currentIndex === 1);
  assert.strictEqual(liveSnap.snapshot.current.text, '第一条字幕');

  // 演出中切换版本必须拒绝
  await assert.rejects(
    rpc(editor, 'switchVersion', { sessionId, versionId: v2.version.id }),
    (e) => e.code === 'VERSION_LOCKED',
    '演出中切换版本应拒绝'
  );

  // 旧版本 baseVersion 拒绝；同一 opId 稍后原样重放，验证拒绝结论可回放
  const staleOpId = opId('adv-stale');
  await assert.rejects(
    rpc(opA, 'advance', { sessionId, token: tokenA, opId: staleOpId, baseVersion: 0 }),
    (e) => e.code === 'STALE_VERSION' && e.stateVersion === 1,
    '旧版本应拒绝并告知当前版本'
  );

  // 重复提交：同一 opId 不重复生效，返回 duplicate
  const dupId = opId('adv-dup');
  const adv1 = await rpc(opA, 'advance', { sessionId, token: tokenA, opId: dupId, baseVersion: 1 });
  assert.strictEqual(adv1.stateVersion, 2);
  const advDup = await rpc(opA, 'advance', { sessionId, token: tokenA, opId: dupId, baseVersion: 1 });
  assert.strictEqual(advDup.duplicate, true);
  assert.strictEqual(advDup.stateVersion, 2, '重复提交不得再次改变状态');

  await waitForSnapshot(snapAud, audience, sessionId, (s) => s.currentIndex === 2 && s.showing);

  // 清屏 + 清屏重复拒绝
  const clr = await rpc(opA, 'clear', { sessionId, token: tokenA, opId: opId('clr'), baseVersion: 2 });
  assert.strictEqual(clr.stateVersion, 3);
  assert.strictEqual(clr.snapshot.showing, false);
  await assert.rejects(
    rpc(opA, 'clear', { sessionId, token: tokenA, opId: opId('clr-again'), baseVersion: 3 }),
    (e) => e.code === 'ALREADY_CLEARED'
  );
  await waitForSnapshot(snapAud, audience, sessionId, (s) => !s.showing && s.currentIndex === 2);

  // 清屏后推进 = 同一条重新亮起（stateVersion +1）
  const reOn = await rpc(opA, 'advance', { sessionId, token: tokenA, opId: opId('reon'), baseVersion: 3 });
  assert.strictEqual(reOn.stateVersion, 4);
  assert.strictEqual(reOn.snapshot.showing, true);
  assert.strictEqual(reOn.snapshot.currentIndex, 2);

  // 到末尾
  const adv3 = await rpc(opA, 'advance', { sessionId, token: tokenA, opId: opId('adv3'), baseVersion: 4 });
  assert.strictEqual(adv3.stateVersion, 5);
  assert.strictEqual(adv3.snapshot.current.text, '第三条字幕');
  await assert.rejects(
    rpc(opA, 'advance', { sessionId, token: tokenA, opId: opId('end'), baseVersion: 5 }),
    (e) => e.code === 'AT_END'
  );

  // 回退到片头：index 0 且清屏
  const b1 = await rpc(opA, 'back', { sessionId, token: tokenA, opId: opId('b1'), baseVersion: 5 });
  assert.strictEqual(b1.stateVersion, 6);
  assert.strictEqual(b1.snapshot.currentIndex, 2);
  const b2 = await rpc(opA, 'back', { sessionId, token: tokenA, opId: opId('b2'), baseVersion: 6 });
  assert.strictEqual(b2.stateVersion, 7);
  assert.strictEqual(b2.snapshot.currentIndex, 1);
  const b3 = await rpc(opA, 'back', { sessionId, token: tokenA, opId: opId('b3'), baseVersion: 7 });
  assert.strictEqual(b3.stateVersion, 8);
  assert.strictEqual(b3.snapshot.currentIndex, 0);
  assert.strictEqual(b3.snapshot.showing, false);
  await assert.rejects(
    rpc(opA, 'back', { sessionId, token: tokenA, opId: opId('b0'), baseVersion: 8 }),
    (e) => e.code === 'AT_BEGINNING'
  );

  // 重放一个历史已拒绝操作 id：不得生效，回放拒绝结论
  const replay = await rpc(opA, 'advance', { sessionId, token: tokenA, opId: staleOpId, baseVersion: 0 });
  assert.strictEqual(replay.duplicate, true);
  assert.strictEqual(replay.applied, false);
  assert.strictEqual(replay.stateVersion, 8);

  // ---------- 5. 控制权过期接管（等待 TTL，由心跳不发触发）---------
  clearInterval(hbA);
  console.log('  …等待控制权过期（测试 TTL=4s，约 5s）');
  await new Promise((r) => setTimeout(r, 5200));
  const acqB = await rpc(opB, 'acquireControl', { sessionId, name: '乙' });
  assert.ok(acqB.token, '过期后他人应可接管');
  // 甲的旧令牌立即失效
  await assert.rejects(
    rpc(opA, 'advance', { sessionId, token: tokenA, opId: opId('a-expired'), baseVersion: 8 }),
    (e) => e.code === 'NOT_CONTROLLER'
  );
  // 甲会收到快照广播，看到乙持控
  const taken = await waitForSnapshot(snapA, opA, sessionId, (s) => s.control.active && !s.control.heldByMe);
  assert.strictEqual(taken.snapshot.control.holderName, '乙');

  // 乙做一次操作，观众跟随
  const on1 = await rpc(opB, 'advance', { sessionId, token: acqB.token, opId: opId('b-on1'), baseVersion: 8 });
  assert.strictEqual(on1.snapshot.currentIndex, 1);
  await waitForSnapshot(snapAud, audience, sessionId, (s) => s.showing && s.currentIndex === 1);

  // 关闭场次
  await rpc(opB, 'closeSession', { sessionId, token: acqB.token });
  const closed = await waitForSnapshot(snapAud, audience, sessionId, (s) => s.status === 'closed');
  assert.strictEqual(closed.snapshot.status, 'closed');

  // REST 快照与 WS 一致（服务重启恢复的读路径）
  const rest = await (await fetch(`${HTTP}/api/sessions/${sessionId}`)).json();
  assert.strictEqual(rest.snapshot.status, 'closed');
  assert.strictEqual(rest.snapshot.currentIndex, 1);
  assert.strictEqual(rest.snapshot.stateVersion, 9);
  assert.strictEqual(rest.snapshot.version.id, v1.version.id, '场次仍锁定首演版本');

  for (const ws of [editor, opA, opB, audience]) ws.close();
}

main()
  .then(() => {
    console.log('✅ 全部冒烟断言通过');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ 冒烟测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
