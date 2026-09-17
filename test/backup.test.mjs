/*
 * backup.js 凭据加解密单测（node --test，零依赖）。
 *
 * 只测 _encryptSecrets / _decryptSecrets 这一对纯函数（backup.js 里已标注「供测试/排查用」）。
 * 备份是全项目唯一会丢数据的路径：密码设错、GCM 标签算错、旧备份读不出来，都表现为
 * 「用户以为备份好了，真要恢复时打不开」，而这件事在界面上永远不报错、只有真去恢复才发现，
 * 所以必须在这里锁死。scrypt 参数（N/r/p）写进密文块、解密时从块里读，跨版本兼容也靠这一条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import backup from '../public/preload/lib/backup.js'

const { _encryptSecrets, _decryptSecrets } = backup

// 真实形状：两项内置凭据 + 各厂商模型的密钥槽位
const secrets = {
  apiKey: 'sk-abc123XYZ_-',
  platformToken: 'Bearer eyJhbGciOi.中文测试.尾巴',
  models: { moonshot: 'sk-moon-1', zhipu: 'raw-token-2' },
}

test('加解密往返：内置凭据与各模型密钥槽位一字不差', () => {
  assert.deepEqual(_decryptSecrets(_encryptSecrets(secrets, 'hunter2!'), 'hunter2!'), secrets)
})

test('同一份明文两次加密得到不同密文（salt / iv 每次新生成）', () => {
  const a = _encryptSecrets(secrets, 'hunter2!')
  const b = _encryptSecrets(secrets, 'hunter2!')
  // salt / iv 复用会让两份备份的相同明文产生相同密文，等于泄露「两人用了同一个 Key」
  assert.notEqual(a.salt, b.salt)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.data, b.data)
  assert.deepEqual(_decryptSecrets(a, 'hunter2!'), _decryptSecrets(b, 'hunter2!'))
})

test('密码错一位就解不开（GCM 认证标签拦下，不会解出半个对象）', () => {
  const blob = _encryptSecrets(secrets, 'hunter2!')
  assert.throws(() => _decryptSecrets(blob, 'hunter2?'))
  assert.throws(() => _decryptSecrets(blob, ''))
})

test('密文或认证标签被改一位就解不开', () => {
  const blob = _encryptSecrets(secrets, 'hunter2!')
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64')
    buf[0] ^= 0x01
    return buf.toString('base64')
  }
  assert.throws(() => _decryptSecrets({ ...blob, data: flip(blob.data) }, 'hunter2!'))
  assert.throws(() => _decryptSecrets({ ...blob, tag: flip(blob.tag) }, 'hunter2!'))
})

test('旧备份（明文只有 apiKey / platformToken）能解出，且不带 models 键', () => {
  // 早期版本的凭据里没有 models；applyBackup 见到 undefined 会沿用现值，
  // 所以这里必须解出「没有这个键」，而不是 null / {}（后者会把用户的模型密钥清空）
  const out = _decryptSecrets(_encryptSecrets({ apiKey: 'sk-old', platformToken: '' }, 'pw123456'), 'pw123456')
  assert.equal(out.apiKey, 'sk-old')
  assert.equal(out.platformToken, '')
  assert.equal('models' in out, false)
})

test('结构不对的密文块报「没有可用的凭据」，不外泄底层异常', () => {
  const msg = /备份里没有可用的凭据/
  assert.throws(() => _decryptSecrets(null, 'pw'), msg)
  assert.throws(() => _decryptSecrets(undefined, 'pw'), msg)
  assert.throws(() => _decryptSecrets('not-an-object', 'pw'), msg)
  assert.throws(() => _decryptSecrets({}, 'pw'), msg)
  assert.throws(() => _decryptSecrets({ salt: 'x' }, 'pw'), msg) // 缺 data
})
