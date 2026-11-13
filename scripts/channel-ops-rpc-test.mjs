import assert from 'node:assert/strict'

/**
 * 一键签到 / 一键唤醒的 RPC 闭环：
 * 触发 → 后台执行 → 流水落账 → 第二次触发因「今天已成功」而 nothing。
 *
 * 用 Loomy 的领取 / 续期替身，零网络；账号在测试结束时删除。
 */
export async function verifyChannelOps({ ctx, call, creds }) {
  const provider = 'loomy'
  const accountId = 'ops-fixture-loomy'
  const ref = 'OPS_ACCOUNT_FIXTURE'
  const savedClaim = ctx.loomyAuth.claimDailyQuota
  const savedRefresh = ctx.loomyAuth.refreshAccountCredential
  let claims = 0
  let refreshes = 0
  const waitIdle = async () => {
    let status
    for (let attempt = 0; attempt < 600; attempt += 1) {
      status = (await call('ops.journal', { provider })).value.status
      if (status.running !== true) return status
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('ops runner did not settle')
  }
  try {
    ctx.loomyAuth.claimDailyQuota = async () => {
      claims += 1
      return { kind: 'claimed', credit: 7, streakDays: 2, isStreakDay: false }
    }
    ctx.loomyAuth.refreshAccountCredential = async () => { refreshes += 1 }
    creds.set(ref, { value: '{"token":"fixture"}' })
    await ctx.accountPool.addAccount({
      id: accountId, provider, nickname: '流水账号', credentialRef: ref,
      enabled: true, refreshable: false, createdAt: 1,
    })

    const initial = await call('ops.journal', { provider })
    assert.equal(initial.ok, true)
    assert.equal(typeof initial.value.today, 'string')
    assert.equal(initial.value.entries.some(entry => entry.accountId === accountId), false)
    assert.equal(initial.value.status.running, false)

    const run = await call('ops.run', { kind: 'checkin' })
    assert.equal(run.ok, true)
    assert.equal(run.value.started, true)
    assert.ok(run.value.status.total >= 1)
    const settled = await waitIdle()
    assert.equal(settled.running, false)
    assert.equal(claims, 1, '一键签到真的调用了签到替身')

    const entries = (await call('ops.journal', { provider, kind: 'checkin' })).value.entries
    const checkin = entries.find(entry => entry.accountId === accountId)
    assert.ok(checkin, '签到后必须有一条逐账号流水')
    assert.equal(checkin.kind, 'checkin')
    assert.equal(checkin.outcome, 'ok')
    assert.equal(checkin.credit, 7)
    assert.equal(checkin.origin, 'manual')
    assert.equal(checkin.day, initial.value.today)

    const again = await call('ops.run', { kind: 'checkin' })
    assert.equal(again.value.started, false)
    assert.equal(again.value.reason, 'nothing', '今天已成功的账号不重复打上游')

    const wake = await call('ops.run', { kind: 'wake' })
    assert.equal(wake.value.started, true)
    await waitIdle()
    assert.equal(refreshes, 1, '一键唤醒真的调用了续期替身')
    const wakeEntry = (await call('ops.journal', { provider, kind: 'wake' })).value.entries
      .find(entry => entry.accountId === accountId)
    assert.ok(wakeEntry, '唤醒后必须有一条唤醒流水')
    assert.equal(wakeEntry.kind, 'wake')
    assert.equal(wakeEntry.outcome, 'ok')
    assert.equal(wakeEntry.origin, 'manual')

    const wakeAgain = await call('ops.run', { kind: 'wake' })
    assert.equal(wakeAgain.value.started, false)
    assert.equal(wakeAgain.value.reason, 'nothing')
  } finally {
    ctx.loomyAuth.claimDailyQuota = savedClaim
    ctx.loomyAuth.refreshAccountCredential = savedRefresh
    await ctx.accountPool.removeAccount(accountId)
    creds.delete(ref)
  }
  console.log('ok  ops journal + one-click check-in/wake: per-account entries, skip already-done, wake round trip')
}
