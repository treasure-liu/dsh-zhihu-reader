import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-zhihu-reader";
export const inject = ["tools"];

const HOME = homedir();
const CONFIG_FILE = path.join(HOME, ".dsh", "zhihu-reader.json");
const DEFAULTS = {
	headless: true,
	cookieFile: path.join(HOME, ".zhihu-cli", "cookies.json"),
	executablePath: "",
	timeoutMs: 60000,
	maxChars: 20000,
	profileDir: path.join(HOME, ".dsh", "zhihu-reader-profile"),
};
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function loadConfig() {
	let user = {};
	try { user = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch {}
	return { ...DEFAULTS, ...user };
}

/** 按常见安装位置探测本机 Chrome / Edge。 */
function findBrowserExecutable(cfg) {
	const candidates = [];
	if (cfg.executablePath) candidates.push(cfg.executablePath);
	const env = process.env;
	if (env["ProgramFiles"]) {
		candidates.push(path.join(env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe"));
		candidates.push(path.join(env["ProgramFiles"], "Microsoft", "Edge", "Application", "msedge.exe"));
	}
	if (env["ProgramFiles(x86)"]) {
		candidates.push(path.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"));
		candidates.push(path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"));
	}
	if (env.LOCALAPPDATA) {
		candidates.push(path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
	}
	candidates.push(
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
	);
	for (const candidate of candidates) {
		try { if (candidate && existsSync(candidate)) return candidate; } catch {}
	}
	return null;
}

/** 读取 pyzhihu-cli 的 cookies.json，转成 Playwright cookie 格式。 */
async function loadCookies(cookieFile) {
	let raw;
	try { raw = JSON.parse(await readFile(cookieFile, "utf8")); } catch { return []; }
	const jar = raw?.cookies ?? raw;
	const out = [];
	const push = (name, value) => {
		const v = typeof value === "object" && value !== null ? (value.value ?? value.rawValue) : value;
		if (name && v != null) out.push({ name, value: String(v), domain: ".zhihu.com", path: "/" });
	};
	if (Array.isArray(jar)) {
		for (const c of jar) if (c && c.name) push(c.name, c.value);
	} else if (jar && typeof jar === "object") {
		for (const [name, value] of Object.entries(jar)) push(name, value);
	}
	return out;
}

/** 从链接或纯数字中解析专栏文章 ID。 */
function parseArticleId(input) {
	const text = String(input ?? "").trim();
	const m = text.match(/(?:zhuanlan\.zhihu\.com|www\.zhihu\.com)\/p\/(\d+)/i);
	if (m) return m[1];
	if (/^\d{6,}$/.test(text)) return text;
	return null;
}

/** 轻量 HTML → 文本（保留图片链接与换行结构）。 */
function htmlToText(html) {
	let s = String(html ?? "");
	s = s.replace(/<img[^>]*\bsrc="([^"]*)"[^>]*>/gi, (_all, src) => `\n![图片](${src})\n`);
	s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/blockquote|\/tr)[^>]*>/gi, "\n");
	s = s.replace(/<li[^>]*>/gi, "- ");
	s = s.replace(/<[^>]+>/g, "");
	s = s
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
	s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

/** 页面导航中调用 content() 会抛错，安全重试。 */
async function safeContent(page) {
	for (let attempt = 0; attempt < 12; attempt += 1) {
		try { return await page.content(); } catch { await page.waitForTimeout(800); }
	}
	return "";
}

/** 用持久化 profile 目录启动浏览器（会话跨次保留，登录一次即可）。 */
async function launchPersistent(pw, cfg, headless) {
	return pw.chromium.launchPersistentContext(cfg.profileDir, {
		executablePath: findBrowserExecutable(cfg),
		headless,
		args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
		locale: "zh-CN",
		viewport: { width: 1366, height: 900 },
		userAgent: USER_AGENT,
	});
}

/** 打开页面并等待反爬挑战自解（挑战 JS 会写 Cookie 并刷新），返回最终 HTML。 */
async function gotoAndSettle(page, url, cfg) {
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs });
	let html = await safeContent(page);
	const deadline = Date.now() + Math.min(cfg.timeoutMs, 30000);
	let reloads = 0;
	while (!html.includes("js-initialData") && Date.now() < deadline) {
		await page.waitForTimeout(2000);
		if (reloads < 2) {
			reloads += 1;
			try { await page.reload({ waitUntil: "domcontentloaded" }); } catch {}
		}
		html = await safeContent(page);
	}
	return html;
}

/** 从搜索结果链接识别内容类型并归一化 URL。 */
function classifyResultUrl(href) {
	const full = href.startsWith("http") ? href : `https://www.zhihu.com${href}`;
	let m = full.match(/\/question\/(\d+)\/answer\/(\d+)/);
	if (m) return { type: "回答", url: full };
	m = full.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/) ?? full.match(/\/p\/(\d+)/);
	if (m) return { type: "专栏", url: `https://zhuanlan.zhihu.com/p/${m[1]}` };
	m = full.match(/\/question\/(\d+)/);
	if (m) return { type: "问题", url: `https://www.zhihu.com/question/${m[1]}` };
	return { type: "链接", url: full };
}

const RESULT_ITEM_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		title: { type: "string" },
		url: { type: "string" },
		type: { type: "string" },
		excerpt: { type: "string" },
		upvotes: { type: "string" },
		author: { type: "string" },
	},
};

function zhihuArticleReadTool() {
	return defineTool({
		name: "zhihu_article_read",
		description:
			"读取知乎专栏文章全文。输入文章链接（zhuanlan.zhihu.com/p/xxx、www.zhihu.com/p/xxx）或纯数字文章 ID，" +
			"返回标题、作者、发布日期与正文文本（超长可用 maxLength 截断）。" +
			"适合需要完整阅读某篇知乎专栏内容时使用；问题与回答请改用 zhihu_question / zhihu_answer，关键词检索请用 zhihu_search。",
		parameters: {
			url: { type: "string", required: true, description: "知乎专栏文章链接或文章 ID，例如 https://zhuanlan.zhihu.com/p/13705026538 或 13705026538" },
			maxLength: { type: "number", description: "返回正文的最大字符数，默认 20000" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					url: { type: "string" },
					title: { type: "string" },
					author: { type: "string" },
					published: { type: "string" },
					textLength: { type: "number" },
					truncated: { type: "boolean" },
					text: { type: "string" },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: value.ok
					? `${value.message}\n标题：${value.title}\n作者：${value.author}\n日期：${value.published}\n链接：${value.url}\n长度：${value.textLength}${value.truncated ? "（已截断）" : ""}\n\n${value.text}`
					: `${value.message}`,
			}],
		},
		async execute(args, exec) {
			const id = parseArticleId(args.url);
			if (!id) {
				return { ok: false, message: "无法从输入解析文章 ID：请提供知乎专栏链接（zhuanlan.zhihu.com/p/xxx）或纯数字文章 ID。", url: String(args.url ?? ""), title: "", author: "", published: "", textLength: 0, truncated: false, text: "" };
			}
			const cfg = loadConfig();
			let pw;
			try {
				pw = await import("playwright-core");
			} catch {
				return { ok: false, message: "playwright-core 未安装：请在插件目录执行 pnpm install，或重新 dsh plugin add。", url: String(args.url ?? ""), title: "", author: "", published: "", textLength: 0, truncated: false, text: "" };
			}
			const executablePath = findBrowserExecutable(cfg);
			if (!executablePath) {
				return { ok: false, message: "未找到本机 Chrome/Edge：可在 ~/.dsh/zhihu-reader.json 里配置 executablePath。", url: `https://zhuanlan.zhihu.com/p/${id}`, title: "", author: "", published: "", textLength: 0, truncated: false, text: "" };
			}
			const url = `https://zhuanlan.zhihu.com/p/${id}`;
			// profile 首次使用时播种 pyzhihu-cli 的 Cookie（若存在），实现与老登录方式的平滑兼容
			const freshProfile = !existsSync(path.join(cfg.profileDir, "Default"));
			let context;
			const onAbort = () => { try { context?.close(); } catch {} };
			exec.signal.addEventListener("abort", onAbort, { once: true });
			try {
				context = await launchPersistent(pw, cfg, cfg.headless !== false);
				if (freshProfile) {
					const seed = await loadCookies(cfg.cookieFile);
					if (seed.length > 0) await context.addCookies(seed);
				}
				const page = context.pages()[0] ?? (await context.newPage());
				const html = await gotoAndSettle(page, url, cfg);
				if (!html.includes("js-initialData")) {
					return { ok: false, message: "页面未能通过知乎反爬挑战（未出现 js-initialData）。可稍后重试，或把配置 headless 改为 false 用有头模式。", url, title: "", author: "", published: "", textLength: 0, truncated: false, text: "" };
				}

				const match = html.match(/id="js-initialData"[^>]*>([\s\S]*?)<\/(?:div|script)>/);
				let art = null;
				if (match) {
					try {
						const json = match[1]
							.replace(/&lt;/g, "<")
							.replace(/&gt;/g, ">")
							.replace(/&quot;/g, '"')
							.replace(/&#39;/g, "'")
							.replace(/&amp;/g, "&");
						const data = JSON.parse(json);
						art = data?.initialState?.entities?.articles?.[id]
							?? data?.entities?.articles?.[id]
							?? null;
					} catch {}
				}
				if (!art) {
					return { ok: false, message: "页面已加载但未能解析出文章数据（可能不是专栏文章，或知乎页面结构变化）。", url, title: "", author: "", published: "", textLength: 0, truncated: false, text: "" };
				}

				const maxChars = Number(args.maxLength) > 0 ? Number(args.maxLength) : cfg.maxChars;
				const full = htmlToText(art.content ?? "");
				const truncated = full.length > maxChars;
				return {
					ok: true,
					message: `已读取专栏《${art.title ?? ""}》`,
					url,
					title: art.title ?? "",
					author: art.author?.name ?? "",
					published: art.created ? new Date(art.created * 1000).toISOString().slice(0, 10) : "",
					textLength: full.length,
					truncated,
					text: truncated ? `${full.slice(0, maxChars)}\n\n[正文过长已截断，可调大 maxLength 获取更多]` : full,
				};
			} catch (error) {
				return { ok: false, message: `读取失败：${error?.message ?? String(error)}`, url, title: "", author: "", published: "", textLength: 0, truncated: false, text: "" };
			} finally {
				exec.signal.removeEventListener("abort", onAbort);
				try { await context?.close(); } catch {}
			}
		},
	});
}

function zhihuReaderLoginTool() {
	return defineTool({
		name: "zhihu_reader_login",
		description:
			"打开浏览器窗口登录知乎（本插件独立登录，不依赖 pyzhihu-cli 的 zhihu_login）。" +
			"会弹出可见的浏览器窗口并打开知乎登录页，扫码或账号密码登录均可；" +
			"插件检测到登录态（z_c0 Cookie）后自动保存会话到本插件独立目录并关闭窗口。" +
			"登录一次长期有效，之后 zhihu_article_read 自动使用该会话。",
		parameters: {
			timeoutSec: { type: "number", description: "等待登录完成的最长秒数，默认 180" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					loggedIn: { type: "boolean" },
					profileDir: { type: "string" },
				},
			},
			render: (_args, value) => [{ type: "text", text: value.message }],
		},
		async execute(args, exec) {
			const cfg = loadConfig();
			let pw;
			try {
				pw = await import("playwright-core");
			} catch {
				return { ok: false, message: "playwright-core 未安装：请重新 dsh plugin add 或在插件目录执行 pnpm install。", loggedIn: false, profileDir: cfg.profileDir };
			}
			if (!findBrowserExecutable(cfg)) {
				return { ok: false, message: "未找到本机 Chrome/Edge：可在 ~/.dsh/zhihu-reader.json 里配置 executablePath。", loggedIn: false, profileDir: cfg.profileDir };
			}
			const timeoutSec = Number(args.timeoutSec) > 0 ? Number(args.timeoutSec) : 180;
			const context = await launchPersistent(pw, cfg, false);
			let closedByUser = false;
			const onAbort = () => { try { context.close(); } catch {} };
			const onClose = () => { closedByUser = true; };
			exec.signal.addEventListener("abort", onAbort, { once: true });
			context.on("close", onClose);
			try {
				const page = context.pages()[0] ?? (await context.newPage());
				await page.goto("https://www.zhihu.com/signin", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
				const deadline = Date.now() + timeoutSec * 1000;
				let hasZc0 = false;
				while (Date.now() < deadline && !closedByUser && !exec.signal.aborted) {
					try {
						const cookies = await context.cookies("https://www.zhihu.com");
						hasZc0 = cookies.some((c) => c.name === "z_c0");
					} catch {}
					if (hasZc0) break;
					await page.waitForTimeout(2000).catch(() => {});
				}
				if (hasZc0) {
					return { ok: true, message: "知乎登录成功：会话已保存在本插件独立目录，读取专栏时自动使用（长期有效，无需重复登录）。", loggedIn: true, profileDir: cfg.profileDir };
				}
				return { ok: false, message: closedByUser ? "浏览器窗口被关闭，登录未完成。可再次调用重试。" : `等待登录超时（${timeoutSec} 秒）。可再次调用重试。`, loggedIn: false, profileDir: cfg.profileDir };
			} catch (error) {
				return { ok: false, message: `登录失败：${error?.message ?? String(error)}`, loggedIn: false, profileDir: cfg.profileDir };
			} finally {
				exec.signal.removeEventListener("abort", onAbort);
				context.removeListener("close", onClose);
				try { await context.close(); } catch {}
			}
		},
	});
}

function zhihuReaderSearchTool() {
	return defineTool({
		name: "zhihu_reader_search",
		description:
			"知乎站内搜索（浏览器版，无需 pyzhihu-cli 与额外登录）。输入关键词，返回综合搜索结果列表：" +
			"标题、类型（回答/专栏/问题）、链接、摘要、赞同数。配合 zhihu_article_read（读专栏全文）、" +
			"zhihu_question / zhihu_answer（读问题与回答，需 @zhengjunyao/dsh-zhihu）可进一步获取完整内容。",
		parameters: {
			q: { type: "string", required: true, description: "搜索关键词，例如：冰雪大世界 避坑" },
			limit: { type: "number", description: "返回条数，默认 10，最大 20" },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true },
					query: { type: "string" },
					total: { type: "number" },
					results: { type: "array", items: RESULT_ITEM_SCHEMA },
				},
			},
			render: (_args, value) => [{ type: "text", text: value.message }],
		},
		async execute(args, exec) {
			const query = String(args.q ?? "").trim();
			const empty = { ok: false, query, total: 0, results: [] };
			if (query === "") return { ...empty, message: "请提供搜索关键词 q。" };
			const cfg = loadConfig();
			let pw;
			try {
				pw = await import("playwright-core");
			} catch {
				return { ...empty, message: "playwright-core 未安装：请重新 dsh plugin add 或在插件目录执行 pnpm install。" };
			}
			if (!findBrowserExecutable(cfg)) {
				return { ...empty, message: "未找到本机 Chrome/Edge：可在 ~/.dsh/zhihu-reader.json 里配置 executablePath。" };
			}
			const freshProfile = !existsSync(path.join(cfg.profileDir, "Default"));
			let context;
			const onAbort = () => { try { context?.close(); } catch {} };
			exec.signal.addEventListener("abort", onAbort, { once: true });
			try {
				context = await launchPersistent(pw, cfg, cfg.headless !== false);
				if (freshProfile) {
					const seed = await loadCookies(cfg.cookieFile);
					if (seed.length > 0) await context.addCookies(seed);
				}
				const page = context.pages()[0] ?? (await context.newPage());
				const url = `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`;
				const html = await gotoAndSettle(page, url, cfg);
				if (!html.includes("js-initialData")) {
					return { ...empty, message: "页面未能通过知乎反爬挑战。可稍后重试，或把配置 headless 改为 false 用有头模式。" };
				}
				try { await page.waitForSelector(".SearchResult-Card", { timeout: 15000 }); } catch {}
				await page.waitForTimeout(1000);
				const raw = await page.evaluate(() => {
					const cards = Array.from(document.querySelectorAll(".SearchResult-Card"));
					return cards.map((card) => {
						const a = card.querySelector(".ContentItem-title a");
						const snippet = card.querySelector(".RichContent-inner");
						const vote = card.querySelector('[class*="VoteButton"]');
						const author = card.querySelector(".UserLink-link");
						const time = card.querySelector(".ContentItem-time");
						return {
							title: a?.textContent?.trim() ?? "",
							href: a?.getAttribute("href") ?? "",
							excerpt: (snippet?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
							upvotes: vote?.textContent?.trim() ?? "",
							author: author?.textContent?.trim() ?? "",
							time: time?.textContent?.trim() ?? "",
						};
					}).filter((r) => r.title !== "" || r.href !== "");
				});
				const limit = Number(args.limit) > 0 ? Math.min(Math.floor(Number(args.limit)), 20) : 10;
				const results = raw.slice(0, limit).map((r) => {
					const c = classifyResultUrl(r.href);
					return { title: r.title, url: c.url, type: c.type, excerpt: r.excerpt, upvotes: r.upvotes, author: r.author };
				});
				const lines = results.map((r, i) => `${i + 1}. [${r.type}] ${r.title}${r.upvotes ? `（${r.upvotes}）` : ""}\n   ${r.url}\n   ${r.excerpt}`);
				return {
					ok: true,
					message: `知乎搜索「${query}」共 ${results.length} 条：\n${lines.join("\n")}`,
					query,
					total: results.length,
					results,
				};
			} catch (error) {
				return { ...empty, message: `搜索失败：${error?.message ?? String(error)}` };
			} finally {
				exec.signal.removeEventListener("abort", onAbort);
				try { await context?.close(); } catch {}
			}
		},
	});
}

export function apply(ctx) {
	ctx.effect(() => ctx.tools.register(zhihuArticleReadTool()), "dsh-zhihu-reader: article tool");
	ctx.effect(() => ctx.tools.register(zhihuReaderSearchTool()), "dsh-zhihu-reader: search tool");
	ctx.effect(() => ctx.tools.register(zhihuReaderLoginTool()), "dsh-zhihu-reader: login tool");
}
