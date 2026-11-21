/**
 * Gemini 中转服务（OpenAI 格式）
 * - 把 OpenAI 格式的 /v1/chat/completions 请求原样转发到
 *   Google 官方的 OpenAI 兼容端点（支持流式 SSE）
 * - 支持多个 Gemini API Key 轮换：某个 key 当天额度用完（429）自动换下一个
 * - GET /healthz 供 UptimeRobot 保活
 *
 * 环境变量：
 *   PORT   - 端口（Render 自动注入，无需设置）
 *   KEYS   - 逗号分隔的 Gemini API Key（必填）
 *   MODELS - 逗号分隔的模型 ID 列表（选填，仅用于 /v1/models 展示，
 *            实际请求里的模型名会原样透传给 Google）
 *   CLIENT_KEY - 访问密码（强烈建议设置）：设置后，调用方必须在
 *            Authorization: Bearer xxx 里带上同样的值才放行，
 *            防止中转地址泄露后被别人白嫖额度
 */
const http = require('http');

const PORT = parseInt(process.env.PORT || '3000', 10);
const KEYS = (process.env.KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = (
  process.env.MODELS ||
  'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-4-hydrogen'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// UPSTREAM 一般不用改；仅用于测试或将来切换其他 OpenAI 格式上游
const GOOGLE_OPENAI_BASE =
  process.env.UPSTREAM ||
  'https://generativelanguage.googleapis.com/v1beta/openai';

let cursor = 0;
function nextKey() {
  if (!KEYS.length) return null;
  const k = KEYS[cursor % KEYS.length];
  cursor++;
  return k;
}

// 访问密码校验：设置了 CLIENT_KEY 就必须带上一致的 Bearer 才放行
function authorized(req) {
  const CLIENT_KEY = process.env.CLIENT_KEY || '';
  if (!CLIENT_KEY) return true; // 未设置则不启用（不推荐）
  return (req.headers['authorization'] || '') === 'Bearer ' + CLIENT_KEY;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function proxyChatCompletion(reqBody, res) {
  if (!KEYS.length) {
    sendJson(res, 500, {
      error: { message: '服务端未配置 KEYS 环境变量' },
    });
    return;
  }

  for (let attempt = 0; attempt < KEYS.length; attempt++) {
    const key = nextKey();
    let upstream;
    try {
      upstream = await fetch(GOOGLE_OPENAI_BASE + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key,
        },
        body: reqBody,
      });
    } catch (e) {
      sendJson(res, 502, {
        error: { message: '连接 Google 失败: ' + e.message },
      });
      return;
    }

    // 429 = 该 key 当日额度耗尽，换下一个 key 重试（最后一个 key 直接透传）
    if (upstream.status === 429 && attempt < KEYS.length - 1) continue;

    res.writeHead(upstream.status, {
      'content-type':
        upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    });
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = () =>
        reader
          .read()
          .then(({ done, value }) => {
            if (done) return res.end();
            res.write(Buffer.from(value));
            return pump();
          })
          .catch(() => {
            try { res.end(); } catch (_) {}
          });
      pump();
    } else {
      res.end();
    }
    return;
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // 保活/健康检查
  if (req.method === 'GET' && (url === '/' || url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('OK');
    return;
  }

  // 模型列表（客户端里填什么模型名就透传什么，这里只是展示用）
  if (req.method === 'GET' && url === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: MODELS.map((id) => ({
        id,
        object: 'model',
        owned_by: 'google',
      })),
    });
    return;
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    if (!authorized(req)) {
      sendJson(res, 401, { error: { message: 'invalid api key' } });
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    proxyChatCompletion(Buffer.concat(chunks), res);
    return;
  }

  sendJson(res, 404, { error: { message: 'not found: ' + url } });
});

server.listen(PORT, () => {
  console.log('Gemini relay listening on port ' + PORT + ', keys: ' + KEYS.length);
});
