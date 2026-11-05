# dsh-zhihu-reader

知乎**专栏文章全文**读取插件（DeepSeek Harness 工具插件）。独立实现，**不依赖 pyzhihu-cli**。

## 为什么需要它

知乎对非浏览器请求有三层拦截：`x-zse-96` 请求签名、`zh-zse-ck` JS 挑战页、风控。
实测（2026-10）：即使携带完整登录 Cookie，纯 HTTP 访问专栏也返回 403。
本插件用 **playwright-core 驱动本机已安装的 Chrome/Edge**（真浏览器指纹天然通过挑战），
从页面 `js-initialData` 解析出标题、作者与正文。

## 工具

| 工具 | 说明 |
|---|---|
| `zhihu_reader_search` | 知乎站内搜索。输入：`q`（关键词）、`limit`（默认 10）。输出：标题 / 类型（回答、专栏、问题）/ 链接 / 摘要 / 赞同数 |
| `zhihu_article_read` | 读取专栏文章全文。输入：`url`（`zhuanlan.zhihu.com/p/xxx` 或纯数字 ID）、`maxLength`（可选截断长度）。输出：标题 / 作者 / 日期 / 正文文本 |
| `zhihu_reader_login` | 弹出浏览器窗口登录知乎（扫码 / 密码均可），会话保存在本插件独立目录，登录一次长期有效。**不依赖 pyzhihu-cli** |

典型的"搜索 + 整理"组合：`zhihu_reader_search` 找内容 → `zhihu_article_read` / `zhihu_question` / `zhihu_answer` 读全文 → 由 AI 汇总。

## 依赖

- 本机装有 Chrome 或 Edge（playwright-core 不下载浏览器，直接驱动本机浏览器）。
- 无其他外部依赖；登录态保存在插件自己的 profile 目录（`~/.dsh/zhihu-reader-profile`）。

## 登录

**公开文章无需登录**即可读取（真浏览器可过反爬挑战）。登录后可改善风控体验并读取部分登录可见内容：

```
对话中调用：zhihu_reader_login { }
→ 弹出浏览器窗口，在窗口内完成知乎登录
→ 检测到 z_c0 后自动保存并关闭窗口
```

兼容性：若本机存在 pyzhihu-cli 的 `~/.zhihu-cli/cookies.json` 且本插件 profile 首次使用，
会自动播种该登录态（老用户无缝迁移）。

## 配置（可选）

`~/.dsh/zhihu-reader.json`：

```json
{
  "headless": true,
  "executablePath": "",
  "timeoutMs": 60000,
  "maxChars": 20000,
  "profileDir": "~/.dsh/zhihu-reader-profile",
  "cookieFile": "~/.zhihu-cli/cookies.json"
}
```

## 安装 / 卸载

```sh
# 从 GitHub（lib/ 预构建提交，无需构建脚本授权）
dsh plugin --profile desktop add github:treasure-liu/dsh-zhihu-reader
# 或本地目录
dsh plugin --profile desktop add <本目录路径>
# 卸载
dsh plugin --profile desktop remove dsh-zhihu-reader
```

安装后重启 DeepSeek Harness。搜索 / 问题 / 回答可配合 `@zhengjunyao/dsh-zhihu` 使用（非必需）。

## 已知边界

- 付费（盐选）内容、评论区分层加载等动态内容不在解析范围。
- 知乎页面结构变更可能导致解析失败，工具会返回 `ok: false` 与原因。
- 请勿高频批量抓取，遵守知乎服务条款。

## License

MIT
