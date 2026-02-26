import 'dotenv/config';
import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import OpenAI from 'openai';
import { PassThrough } from 'stream';

const app = new Koa();
const router = new Router();
const PORT = 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL
});

console.log(process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL);

router.get('/', async (ctx) => {
  ctx.body = { message: 'Koa + TypeScript + OpenAI SDK Ready' };
});
 
// POST /v1/chat/completions - 透传前端参数到 OpenAI，返回结果
router.post('/v1/chat/completions', async (ctx) => {
  const body = ctx.request.body as Record<string, any>;

  try {
    if (body.stream) {
      // 流式响应：SSE
      ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const stream = await openai.chat.completions.create({
        ...body,
        stream: true,
      } as any);

      const passthrough = new PassThrough();
      ctx.status = 200;
      ctx.body = passthrough;

      (async () => {
        try {
          for await (const chunk of stream as any) {
            passthrough.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          passthrough.write('data: [DONE]\n\n');
        } catch (e: any) {
          passthrough.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        } finally {
          passthrough.end();
        }
      })();
    } else {
      // 非流式响应：直接返回 JSON
      const completion = await openai.chat.completions.create({
        ...body,
      } as any);
      ctx.body = completion;
    }
  } catch (err: any) {
    ctx.status = err.status || 500;
    ctx.body = { error: err.message || 'OpenAI API 调用失败' };
  }
});



app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
