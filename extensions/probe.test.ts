/**
 * Tests for local process probing — missing vs executable vs error.
 * No network; fixed side-effect-free argv only.
 */
import { describe, it, expect } from "vitest";
import { probeCommand, probePythonImport } from "./probe.js";

describe("probeCommand", () => {
	it("reports missing for an unknown binary", async () => {
		const r = await probeCommand("definitely-not-a-real-binary-xyz", ["--version"]);
		expect(r.status).toBe("missing");
	});

	it("reports ok for node --version", async () => {
		const r = await probeCommand("node", ["--version"]);
		expect(r.status).toBe("ok");
		expect(r.output).toMatch(/v\d+\./);
	});

	it("reports error for a bad flag (non-zero exit)", async () => {
		const r = await probeCommand("node", ["--definitely-bad-flag-xyz"]);
		expect(r.status).toBe("error");
	});
});

describe("probePythonImport", () => {
	it("imports stdlib sys", async () => {
		const r = await probePythonImport("sys");
		expect(r.status).toBe("ok");
	});

	it("reports missing for a nonexistent module", async () => {
		const r = await probePythonImport("definitely_not_a_real_module_xyz");
		expect(r.status).toBe("missing");
	});
});
