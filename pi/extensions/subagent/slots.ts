export class Slots {
	private free: number;
	private waiters: Array<() => void> = [];

	constructor(size: number) {
		this.free = size;
	}

	get full(): boolean {
		return this.free === 0;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.free > 0) this.free--;
		else
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) return reject(signal.reason);
				const grant = () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				};
				const onAbort = () => {
					this.waiters.splice(this.waiters.indexOf(grant), 1);
					reject(signal?.reason);
				};
				this.waiters.push(grant);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) next();
			else this.free++;
		};
	}
}
