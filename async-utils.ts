export function describeAsyncError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || /aborted/i.test(error.message);
	}
	return /aborted/i.test(String(error));
}

export function isTimeoutError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "TimeoutError" || /timed? out|timeout/i.test(error.message);
	}
	return /timed? out|timeout/i.test(String(error));
}

export function parsePromptTooLongLimit(error: unknown):
	| { promptTokens: number; maxTokens: number }
	| null {
	const message = describeAsyncError(error);
	const match = message.match(/prompt is too long:\s*(\d+)\s*tokens\s*>\s*(\d+)\s*maximum/i);
	if (!match) return null;
	return {
		promptTokens: parseInt(match[1], 10),
		maxTokens: parseInt(match[2], 10),
	};
}

export function isRetryableOmError(error: unknown): boolean {
	const message = describeAsyncError(error).toLowerCase();
	if (!message) return false;

	if (
		message.includes("invalid_request_error") ||
		message.includes("prompt is too long") ||
		message.includes("model not found") ||
		message.includes("no auth configured") ||
		message.includes("auth failed")
	) {
		return false;
	}

	return (
		/timeout|timed out|rate limit|overloaded|temporar|unavailable|socket|network|fetch failed|econn|429|500|502|503|504/i.test(
			message,
		) ||
		isTimeoutError(error)
	);
}

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
	const delay = Math.max(0, baseDelayMs) * Math.pow(2, Math.max(0, attempt - 1));
	return Math.min(Math.max(0, maxDelayMs), delay);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
		};

		const cleanup = () => {
			clearTimeout(timer);
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

export function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let parentListener: (() => void) | null = null;

	const abortWithReason = (reason: unknown) => {
		if (controller.signal.aborted) return;
		controller.abort(reason instanceof Error ? reason : new Error(String(reason || "Operation aborted")));
	};

	if (timeoutMs > 0) {
		timer = setTimeout(() => {
			abortWithReason(new Error(`Timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}

	if (parentSignal) {
		if (parentSignal.aborted) {
			abortWithReason(parentSignal.reason || new Error("Operation aborted"));
		} else {
			parentListener = () => abortWithReason(parentSignal.reason || new Error("Operation aborted"));
			parentSignal.addEventListener("abort", parentListener, { once: true });
		}
	}

	return {
		signal: controller.signal,
		dispose: () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (parentSignal && parentListener) {
				parentSignal.removeEventListener("abort", parentListener);
				parentListener = null;
			}
		},
	};
}
