import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseRolloutJsonlContent, buildAgentQuotaReport, findLatestRolloutSnapshot } from '../skills/codex-quota-optimizer/scripts/check_quota.mjs';
import { scheduleTasksAgainstQuota } from '../skills/codex-quota-optimizer/scripts/optimize_work_plan.mjs';
const dir = 'skills/codex-quota-optimizer/scripts/';
const now = Date.parse('2026-11-05T00:00:00Z');
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/rate-limits.json', 'utf8'));
const parse = (event = fixture, time = now) => parseRolloutJsonlContent(JSON.stringify(event) + '\n{partial', 'fixture.jsonl', time);
const report = (p, w) => buildAgentQuotaReport({ primary_window: { used_percent: p }, secondary_window: { used_percent: w } });
test('fixture: fresh values and relative/absolute resets age from event timestamp', () => {
  const snap = parse();
  assert.equal(snap.primary_window.used_percent, 87.5);
  assert.equal(snap.primary_window.resets_in_seconds, 4080);
  assert.equal(snap.secondary_window.resets_in_seconds, 259080);
});
for (const envelope of ['payload', 'top-level', 'msg']) {
  for (const windowAliases of [false, true]) {
    test(`synthetic aliases: ${envelope}, ${windowAliases ? 'primary_window/secondary_window' : 'primary/secondary'}`, () => {
      const { primary, secondary } = fixture.payload.rate_limits;
      const limits = {
        plan_type: 'plus',
        limit_id: 'codex',
        [windowAliases ? 'primary_window' : 'primary']: primary,
        [windowAliases ? 'secondary_window' : 'secondary']: secondary,
      };
      const event = { timestamp: fixture.timestamp };
      if (envelope === 'top-level') event.rate_limits = limits;
      else event[envelope] = { rate_limits: limits };

      const snap = parseRolloutJsonlContent(JSON.stringify(event), 'synthetic.jsonl', now);
      assert.equal(snap.captured_at, fixture.timestamp);
      assert.deepEqual(snap.primary_window, {
        window_minutes: 300,
        used_percent: 87.5,
        observed_used_percent: 87.5,
        resets_in_seconds: 4080,
        telemetry_status: 'fresh',
      });
      assert.deepEqual(snap.secondary_window, {
        window_minutes: 10080,
        used_percent: 58,
        observed_used_percent: 58,
        resets_in_seconds: 259080,
        telemetry_status: 'fresh',
      });

      const otherLimits = { ...limits, limit_id: 'other-model' };
      const otherEvent = { timestamp: '2026-11-05T00:00:00Z' };
      if (envelope === 'top-level') otherEvent.rate_limits = otherLimits;
      else otherEvent[envelope] = { rate_limits: otherLimits };
      assert.equal(parseRolloutJsonlContent(JSON.stringify(otherEvent), 'synthetic.jsonl', now), null);
      assert.deepEqual(
        parseRolloutJsonlContent([event, otherEvent].map(value => JSON.stringify(value)).join('\n'), 'synthetic.jsonl', now),
        snap,
      );
    });
  }
}
test('stale, expired, invalid timestamps and wrong durations stay unknown', () => {
  for (const event of [ { ...fixture, timestamp: 'bad' }, { ...fixture, timestamp: '2020-01-01T00:00:00Z' },
    { ...fixture, payload: { rate_limits: { primary: { used_percent: 5, window_minutes: 60 } } } } ]) {
    assert.equal(parse(event).primary_window.used_percent, null);
  }
  assert.equal(parse(fixture, now + 5 * 86400000).primary_window.telemetry_status, 'stale');
  const expired = structuredClone(fixture); expired.payload.rate_limits.primary.resets_in_seconds = 1;
  assert.equal(parse(expired).primary_window.used_percent, null);
});
test('missing secondary and malformed usage never become zero quota usage', () => {
  const event = structuredClone(fixture); delete event.payload.rate_limits.secondary;
  assert.equal(buildAgentQuotaReport(parse(event)).secondary_window_weekly.used_percent, null);
  for (const value of [null, -1, 101, '5', NaN, Infinity]) assert.equal(report(value, 30).primary_window_5h.used_percent, null);
});
test('latest event timestamp wins over file mtime and handles missing explicit file', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-regression-')); t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  fs.mkdirSync(path.join(home, 'sessions'));
  const older = {...fixture, timestamp: '2026-11-04T00:00:00Z'};
  fs.writeFileSync(path.join(home,'sessions','rollout-new.jsonl'), JSON.stringify(fixture));
  fs.writeFileSync(path.join(home,'sessions','rollout-old.jsonl'), JSON.stringify(older));
  assert.equal(findLatestRolloutSnapshot(home).captured_at, fixture.timestamp);
  assert.equal(findLatestRolloutSnapshot(home, path.join(home,'missing')), null);
});
test('both CLIs expose unknown telemetry and defer without fabricated budgets', () => {
  for (const script of ['check_quota.mjs', 'optimize_work_plan.mjs']) {
    const result = JSON.parse(execFileSync(process.execPath, [dir+script, '--rollout-file=missing-fixture.jsonl', '--format=json'], {encoding:'utf8'}));
    assert.equal(result.telemetry_status, 'unknown_or_stale');
    if (result.schedule) assert.ok(result.schedule.every(t => t.action === 'DEFER_UNTIL_RESET'));
    else { assert.equal(result.primary_window_5h.used_percent, null); assert.equal(result.primary_window_5h.resets_in_seconds, null); }
  }
});
test('invalid overrides and malformed task JSON fail visibly', () => {
  for (const args of [['check_quota.mjs','--5h=NaN'], ['check_quota.mjs','--weekly=-1'], ['optimize_work_plan.mjs','--tasks=bad']]) {
    assert.notEqual(spawnSync(process.execPath, [dir+args[0], '--rollout-file=missing-fixture.jsonl', ...args.slice(1)], {encoding:'utf8'}).status, 0);
  }
});
test('scheduler guards actual selected cost for weekly-only and .35/.38 gap cases', () => {
  const tasks = [{title:'boundary', priority:'P0', est_5h_pct:10, est_weekly_pct:10}];
  for (const [p,w] of [[91.4,0],[0,91.4],[0,90],[95,0],[0,95],[94.9,94.9]]) {
    const plan = scheduleTasksAgainstQuota(tasks, report(p,w));
    assert.ok(plan.projected_final_5h_used_pct <= 95);
    assert.ok(plan.projected_final_weekly_used_pct <= 95);
  }
});
test('queue reserve invariants across priorities, plans, boundaries and stricter reserve', () => {
  for (const p of [0,64.9,84.9,90,94.9,95]) for (const w of [0,69.9,87.9,90,94.9,95]) {
    const r = report(p,w); r.pro_exempt_5h = true;
    const tasks = ['P0','P1','P2'].map(priority => ({title:priority, priority, est_5h_pct:10,est_weekly_pct:10}));
    const plan = scheduleTasksAgainstQuota(tasks,r);
    assert.ok(plan.projected_final_5h_used_pct <= 95); assert.ok(plan.projected_final_weekly_used_pct <= 95);
  }
  assert.throws(() => scheduleTasksAgainstQuota([{est_5h_pct:-2}],report(0,0)));
  assert.equal(buildAgentQuotaReport({primary_window:{used_percent:96},secondary_window:{used_percent:0},plan_type:'pro'}).optimization_policy.mode,'RESERVE_STOP');
});
test('MCP missing-telemetry responses use same report and scheduler', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-mcp-'));
  try {
    const input = [{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_codex_usage_limits'}},
      {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'optimize_codex_task_plan',arguments:{tasks:[{title:'task'}]}}}].map(JSON.stringify).join('\n')+'\n';
    const env = {...process.env, CODEX_HOME:home}; delete env.CODEX_PRIMARY_USED_PCT; delete env.CODEX_WEEKLY_USED_PCT;
    const result = spawnSync(process.execPath,[dir+'mcp_server.mjs'],{input,encoding:'utf8',env});
    assert.equal(result.status,0);
    const replies=result.stdout.trim().split('\n').map(JSON.parse).map(r=>JSON.parse(r.result.content[0].text));
    assert.equal(replies[0].telemetry_status,'unknown_or_stale'); assert.equal(replies[1].schedule[0].action,'DEFER_UNTIL_RESET');
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});
test('discovery mirror matches canonical skill byte for byte', () => {
  function walk(rel='') { for (const e of fs.readdirSync('skills/codex-quota-optimizer/'+rel,{withFileTypes:true})) {
    const file=path.join(rel,e.name); if(e.isDirectory()) walk(file);
    else assert.deepEqual(fs.readFileSync('skills/codex-quota-optimizer/'+file),fs.readFileSync('.agents/skills/codex-quota-optimizer/'+file));
  }} walk();
});

test('models use current IDs with reasoning separate from the ID', () => {
  for (const size of ['XS','S','M','L','XL']) {
    const policy=buildAgentQuotaReport({primary_window:{used_percent:10},secondary_window:{used_percent:20}},{taskSize:size}).optimization_policy;
    assert.equal(policy.recommended_model, ['XS','S'].includes(size) ? 'gpt-6-luna' : 'gpt-6.1-sol');
    assert.ok(['low','medium','high'].includes(policy.recommended_reasoning_effort));
  }
});
test('exact ceiling accepts finishing task and defers following task; stricter reserves apply', () => {
  const tasks=[{title:'finish',priority:'P0',est_5h_pct:10,est_weekly_pct:0},{title:'next',priority:'P0',est_5h_pct:1}];
  const plan=scheduleTasksAgainstQuota(tasks,report(91.2,0));
  assert.equal(plan.schedule[0].projected_5h_used_after_pct,95);
  assert.equal(plan.schedule[1].action,'DEFER_UNTIL_RESET');
  const stricter=buildAgentQuotaReport({primary_window:{used_percent:90},secondary_window:{used_percent:0}},{reservePct:10});
  assert.equal(stricter.optimization_policy.mode,'RESERVE_STOP');
  assert.equal(scheduleTasksAgainstQuota(tasks,stricter).schedule[0].action,'DEFER_UNTIL_RESET');
});
