import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { RunRegistry } from "./registry.ts";
import { Lines, widgetLines } from "./render.ts";

const WIDGET_KEY = "subagents";

// Shows one line per live run above the editor; the 1s tick keeps elapsed time
// moving while a child sits in a long tool call that emits no events.
export class SubagentWidget {
	private readonly registry: RunRegistry;
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private shown = false;
	private ticker: ReturnType<typeof setInterval> | undefined;

	constructor(registry: RunRegistry) {
		this.registry = registry;
		registry.subscribe(() => this.sync());
	}

	bind(ctx: ExtensionContext): void {
		if (ctx.mode === "tui" && ctx.hasUI) this.ui = ctx.ui;
	}

	dispose(): void {
		this.hide();
		this.ui = undefined;
	}

	private sync(): void {
		const live = this.registry.live().length > 0;
		if (live && !this.shown) this.show();
		else if (!live && this.shown) this.hide();
		else if (this.shown) this.tui?.requestRender();
	}

	private show(): void {
		if (!this.ui) return;
		try {
			this.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return new Lines((width) => widgetLines(this.registry, width, theme));
			});
		} catch {
			this.ui = undefined;
			return;
		}
		this.shown = true;
		this.ticker = setInterval(() => this.tui?.requestRender(), 1000);
		this.ticker.unref?.();
	}

	private hide(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		if (this.shown) {
			try {
				this.ui?.setWidget(WIDGET_KEY, undefined);
			} catch {
				this.ui = undefined; // stale ctx after a session switch
			}
		}
		this.shown = false;
		this.tui = undefined;
	}
}
