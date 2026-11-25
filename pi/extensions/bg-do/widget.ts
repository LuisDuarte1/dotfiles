import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type JobStore, lastLine } from "./jobs.ts";
import { Lines, widgetLines } from "./render.ts";

const WIDGET_KEY = "bg-do";

// Shows one line per pending notify above the editor; logs are read on the 1s tick,
// never in render, so a repaint storm cannot turn into a burst of file reads.
export class NotifyWidget {
	private readonly store: JobStore;
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private shown = false;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private tails = new Map<string, string>();

	constructor(store: JobStore) {
		this.store = store;
		store.subscribe(() => this.sync());
	}

	bind(ctx: ExtensionContext): void {
		if (ctx.mode === "tui" && ctx.hasUI) this.ui = ctx.ui;
		this.sync();
	}

	dispose(): void {
		this.hide();
		this.ui = undefined;
	}

	private refresh(): void {
		const tails = new Map<string, string>();
		for (const job of this.store.pending()) tails.set(job.id, lastLine(job.log));
		this.tails = tails;
	}

	private sync(): void {
		const live = this.store.pending().length > 0;
		if (live && !this.shown) this.show();
		else if (!live && this.shown) this.hide();
		else if (this.shown) {
			this.refresh();
			this.tui?.requestRender();
		}
	}

	private show(): void {
		if (!this.ui) return;
		this.refresh();
		try {
			this.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return new Lines((width) =>
					widgetLines(this.store.pending(), this.tails, Date.now(), theme).map((line) => truncateToWidth(line, width)),
				);
			});
		} catch {
			this.ui = undefined;
			return;
		}
		this.shown = true;
		this.ticker = setInterval(() => {
			this.refresh();
			this.tui?.requestRender();
		}, 1000);
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
