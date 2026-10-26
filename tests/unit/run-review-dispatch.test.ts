import { describe, expect, it, vi } from "vitest";
import { reviewDispatch } from "../../packages/cli/src/commands/run-compose.ts";

const input = (reviewer: string) => ({ taskId: "t", attemptId: "a", revision: "a".repeat(40), reviewer, acceptanceCriteria: [], evidence: [] });
const service = (verdict: string) => ({ reviewDetailed: vi.fn(async () => ({ verdict }) as never) });

describe("the loop's review function by reviewer name (decision 124)", () => {
  it("sends code reviews to the code service and design reviews to the design service, each with its recorded verdict", async () => {
    const code = service("pass"), design = service("fail");
    const review = reviewDispatch(code, design);
    expect(await review(input("code"))).toEqual({ status: "pass", recorded: true });
    expect(code.reviewDetailed).toHaveBeenCalledWith({ taskId: "t", attemptId: "a", revision: "a".repeat(40) });
    expect(design.reviewDetailed).not.toHaveBeenCalled();
    expect(await review(input("design"))).toEqual({ status: "fail", recorded: true });
    expect(design.reviewDetailed).toHaveBeenCalledOnce();
    expect(code.reviewDetailed).toHaveBeenCalledOnce();
  });
  it("keeps a design infrastructure error an error, never a pass or a code failure (decision 111)", async () => {
    expect(await reviewDispatch(service("pass"), service("error"))(input("design"))).toEqual({ status: "error", recorded: true });
  });
  it("gives a design review without a design service, or an unknown reviewer, no verdict", async () => {
    const code = service("pass");
    expect(await reviewDispatch(code)(input("design"))).toEqual({ status: "error", recorded: true });
    expect(await reviewDispatch(code, service("pass"))(input("security"))).toEqual({ status: "error", recorded: true });
    expect(code.reviewDetailed).not.toHaveBeenCalled();
  });
});
