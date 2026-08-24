/**
 * Deterministic unit coverage for TurnControllerRegistry's multi-turn room
 * tracking: an abort issued from inside a turn spares the calling turn and
 * kills its concurrent siblings, while out-of-band aborts kill everything.
 * Real registry, no mocks.
 */
import { describe, expect, it } from "vitest";
import { TurnAbortedError, TurnControllerRegistry } from "./turn-controller";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("TurnControllerRegistry", () => {
	it("an in-turn abort spares the calling turn and aborts its sibling", async () => {
		const registry = new TurnControllerRegistry();
		const siblingStarted = deferred();
		const release = deferred();

		const sibling = registry.runWith("room-1", async (signal) => {
			siblingStarted.resolve();
			await release.promise;
			if (signal.aborted) throw signal.reason;
			return "sibling-survived";
		});
		const siblingOutcome =
			expect(sibling).rejects.toBeInstanceOf(TurnAbortedError);
		await siblingStarted.promise;

		const caller = registry.runWith("room-1", async (signal) => {
			const aborted = registry.abortTurn("room-1", "user_requested_abort");
			release.resolve();
			return { aborted, selfAborted: signal.aborted };
		});

		await siblingOutcome;
		await expect(caller).resolves.toEqual({
			aborted: true,
			selfAborted: false,
		});
		expect(registry.hasActiveTurn("room-1")).toBe(false);
	});

	it("an in-turn abort with no siblings aborts nothing", async () => {
		const registry = new TurnControllerRegistry();
		const result = await registry.runWith("room-1", async (signal) => ({
			aborted: registry.abortTurn("room-1", "user_requested_abort"),
			selfAborted: signal.aborted,
		}));
		expect(result).toEqual({ aborted: false, selfAborted: false });
	});

	it("an out-of-band abort kills only the latest waiter, preserving the owner", async () => {
		const registry = new TurnControllerRegistry();
		const ownerDone = deferred();
		const waiterStarted = deferred();
		const turns = [
			// Owner: completes normally (no await for abort)
			registry.runWith("room-1", async (signal) => {
				ownerDone.resolve();
				return 0;
			}),
			// Waiter: waits for abort
			registry.runWith("room-1", async (signal) => {
				waiterStarted.resolve();
				await new Promise<void>((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
				return 1;
			}),
		];
		// Wait for owner to complete, waiter to start
		await Promise.all([ownerDone.promise, waiterStarted.promise]);

		// Out-of-band abort (e.g., HTTP stop route, test) targets ONLY the
		// most recent waiter (last in array), preserving the owner (first).
		expect(registry.abortTurn("room-1", "http-stop")).toBe(true);

		// First turn (owner) should complete normally
		const [ownerResult, waiterResult] = await Promise.allSettled(turns);
		if (ownerResult.status === "fulfilled") {
			expect(ownerResult.value).toBe(0);
		} else {
			throw new Error("Owner should not be aborted");
		}

		// Second turn (waiter) should be aborted
		if (waiterResult.status === "rejected") {
			expect(waiterResult.reason).toBeInstanceOf(TurnAbortedError);
			expect((waiterResult.reason as TurnAbortedError).reason).toBe(
				"http-stop",
			);
		} else {
			throw new Error("Waiter should be aborted");
		}

		// Owner already completed, no active turns after owner done
		expect(registry.hasActiveTurn("room-1")).toBe(false);
	});
});
