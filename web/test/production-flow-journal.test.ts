import { expect, test } from "bun:test";
import { productionJournalRows } from "../src/lib/canvas/production-agent-journal";
import type { AgentEvent } from "../src/services/api/agent";

test("flow stop and publication preserve actual local cause and deduplicate replay", () => {
    const events: AgentEvent[] = [
        {eventId:"e1",runId:"r",seq:1,type:"production_flow_stopped",payload:{text:"本地发布冲突，已有结果保留",errorSource:"application"},createdAt:"2026-11-07T00:00:00Z"},
        {eventId:"e2",runId:"r",seq:2,type:"production_flow_published",payload:{text:"已从采用内容发布"},createdAt:"2026-11-07T00:01:00Z"},
    ];
    const rows = productionJournalRows([...events,...events],"r");
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("主任务已暂停");
    expect(rows[0].detail).toContain("本地发布冲突");
    expect(rows[0].failed).toBeFalse();
    expect(rows[1].title).toBe("成果已发布");
});
