import { WebSearchActivityParser, type WebSearchActivity } from "./activity.ts";
import type { WebSearchBackend } from "./payload.ts";
import { AnthropicRawContentRecorder, type RawContentRecord } from "./raw-content.ts";

export class SseJsonParser {
	private buffer = "";

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		return this.readBlocks(false);
	}

	finish(): unknown[] {
		return this.readBlocks(true);
	}

	private readBlocks(flush: boolean): unknown[] {
		const events: unknown[] = [];

		for (;;) {
			const boundary = this.buffer.match(/\r?\n\r?\n/);
			if (!boundary || boundary.index === undefined) break;
			const block = this.buffer.slice(0, boundary.index);
			this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
			const event = this.readBlock(block);
			if (event !== undefined) events.push(event);
		}

		if (flush && this.buffer.trim()) {
			const event = this.readBlock(this.buffer);
			this.buffer = "";
			if (event !== undefined) events.push(event);
		}

		return events;
	}

	private readBlock(block: string): unknown | undefined {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data || data === "[DONE]") return undefined;

		try {
			return JSON.parse(data);
		} catch {
			return undefined;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getNativeWebSearchBackend(body: string): WebSearchBackend | undefined {
	if (!body.includes('"web_search')) return undefined; // skip JSON.parse on the common path
	try {
		const payload = JSON.parse(body);
		if (!isRecord(payload) || !Array.isArray(payload.tools)) return undefined;
		for (const tool of payload.tools) {
			if (!isRecord(tool)) continue;
			if (tool.type === "web_search") return "openai";
			if (tool.type === "web_search_20250305" && tool.name === "web_search") return "anthropic";
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function requestBackend(input: RequestInfo | URL, init?: RequestInit): Promise<WebSearchBackend | undefined> {
	const body = init?.body;
	if (typeof body === "string") return getNativeWebSearchBackend(body);
	if (body instanceof Uint8Array) return getNativeWebSearchBackend(new TextDecoder().decode(body));
	if (input instanceof Request) {
		try {
			return getNativeWebSearchBackend(await input.clone().text());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function rebuildResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
	const rebuilt = new Response(body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
	Object.defineProperties(rebuilt, {
		redirected: { value: response.redirected },
		type: { value: response.type },
		url: { value: response.url },
	});
	return rebuilt;
}

async function consumeActivities(
	body: ReadableStream<Uint8Array>,
	backend: WebSearchBackend,
	onActivity: (activity: WebSearchActivity) => void,
	onRawContent: (record: RawContentRecord) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseJsonParser();
	const activities = new WebSearchActivityParser(backend);
	const recorder = backend === "anthropic" ? new AnthropicRawContentRecorder() : undefined;

	const dispatch = (events: unknown[]) => {
		for (const event of events) {
			for (const activity of activities.push(event)) onActivity(activity);
			const record = recorder?.push(event);
			if (record) onRawContent(record);
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		dispatch(sse.push(decoder.decode(value, { stream: true })));
	}
	dispatch(sse.push(decoder.decode()));
	dispatch(sse.finish());
}

export function installWebSearchStreamObserver(
	onActivity: (activity: WebSearchActivity) => void,
	onRawContent: (record: RawContentRecord) => void,
): () => void {
	const originalFetch = globalThis.fetch;
	const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
		const backend = await requestBackend(input, init);
		const response = await originalFetch(input, init);
		if (!backend || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
			return response;
		}

		const [providerBody, observerBody] = response.body.tee();
		void consumeActivities(observerBody, backend, onActivity, onRawContent).catch(() => undefined);
		return rebuildResponse(response, providerBody);
	};

	globalThis.fetch = wrappedFetch;
	return () => {
		if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
	};
}
