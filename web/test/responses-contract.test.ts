import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig, createModelChannel, buildApiUrl } from "../src/stores/use-config-store";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { resolveTextRequestConfig } from "../src/services/api/text-protocol-routing";
import { requestStreamingResponse } from "../src/services/api/image-streaming";
import { requestImageQuestion, requestToolResponse } from "../src/services/api/image";
import { toResponseTool } from "../src/services/api/image-protocols";
import type { ModelProtocolConfig } from "../src/lib/model-protocols";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function configuration(protocols?: ModelProtocolConfig) {
    const channel = createModelChannel({ id:"fixture", scope:"user", name:"Fixture", baseUrl:"https://example.com/v1", apiKey:"test-only", apiFormat:"openai", interfaceType:"chat-completion", models:["fixture-model"], modelCosts:[{model:"fixture-model", capability:"text", protocol:"chat-completion", billingMode:"fixed_request", unitPriceMicrocredits:0, capabilityConfig:{...defaultModelCapabilityConfig("chat-completion"), protocols}}] });
    return {...defaultConfig, model:"fixture::fixture-model", textModel:"fixture::fixture-model", channels:[channel]};
}

const completed = {status:"completed", output:[{type:"message", content:[{type:"output_text",text:"complete"}]}]};

describe("Responses text call sites", () => {
    test("relay URLs preserve proxy paths, explicit versions and query parameters", () => {
        expect(buildApiUrl("https://example.com", "/responses")).toBe("https://example.com/v1/responses");
        expect(buildApiUrl("https://example.com/proxy/v4?tenant=one", "/responses?mode=test")).toBe("https://example.com/proxy/v4/responses?tenant=one&mode=test");
        expect(buildApiUrl("https://example.com/proxy/v4", "/v2/responses")).toBe("https://example.com/proxy/v2/responses");
        expect(buildApiUrl("https://example.com/proxy%20path/v1beta", "/responses")).toBe("https://example.com/proxy%20path/v1beta/responses");
        expect(buildApiUrl("/api/ai/system/channel", "/responses")).toBe("/api/ai/system/channel/responses");
    });
    test("prefers declared Responses; fixed and undeclared models retain Chat", () => {
        expect(resolveTextRequestConfig(configuration()).interfaceType).toBe("chat-completion");
        expect(resolveTextRequestConfig(configuration({policy:"fixed",supported:["openai-response"]})).interfaceType).toBe("chat-completion");
        expect(resolveTextRequestConfig(configuration({policy:"auto",supported:["openai-response"]}))).toMatchObject({interfaceType:"openai-response", apiFormat:"openai", model:"fixture-model"});
    });

    test("tools keep optional parameters unless strict is explicitly requested", () => {
        const functionTool = {type:"function" as const, function:{name:"read",parameters:{type:"object"}}};
        expect(toResponseTool(functionTool).strict).toBe(false);
        expect(toResponseTool({...functionTool,function:{...functionTool.function, strict:true}}).strict).toBe(true);
    });

    test("editor, front-end model test and plugin tool calls use the declared endpoint", async () => {
        const bodies: Record<string,unknown>[] = [];
        globalThis.fetch = (async (_url, init) => {
            expect(new Headers(init?.headers).get("X-Canvas-Upstream-URL")).toEndWith("/responses");
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json(completed);
        }) as typeof fetch;
        const config = configuration({policy:"auto",supported:["openai-response"]});
        expect(await requestImageQuestion(config,[{role:"user",content:"test"}],()=>{})).toBe("complete");
        expect((await requestToolResponse(config,[{role:"user",content:"test"}],[])).content).toBe("complete");
        expect(bodies).toHaveLength(2);
        for (const body of bodies) expect(body).toMatchObject({store:false,stream:true,model:"fixture-model"});
    });

    test("accepts final JSON even when streaming was requested", async () => {
        globalThis.fetch = (async () => Response.json(completed)) as typeof fetch;
        const deltas: string[] = [];
        const result = await requestStreamingResponse({...defaultConfig,baseUrl:"https://example.com",apiKey:"test"},{model:"fixture"},text=>deltas.push(text));
        expect(result.content).toBe("complete");
        expect(deltas).toEqual(["complete"]);
    });

    for (const ending of ["", "data: [DONE]\n\n", 'event: response.failed\ndata: {"response":{"status":"failed"}}\n\n', 'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n']) {
        test(`rejects unfinished SSE (${ending.slice(0,40) || "EOF"}) without retry`, async () => {
            let calls=0;
            globalThis.fetch = (async () => { calls++; return new Response('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n'+ending,{headers:{"content-type":"text/event-stream"}}); }) as typeof fetch;
            await expect(requestStreamingResponse({...defaultConfig,baseUrl:"https://example.com"},{model:"fixture"})).rejects.toThrow("未完成");
            expect(calls).toBe(1);
        });
    }

    test("completed SSE preserves tools and is not dependent on data.type", async () => {
        const payload={status:"completed",output:[{type:"function_call",call_id:"call-1",name:"read",arguments:"{}"}]};
        globalThis.fetch=(async()=>new Response(`event: response.completed\ndata: ${JSON.stringify({response:payload})}\n\n`,{headers:{"content-type":"text/event-stream"}})) as typeof fetch;
        const result=await requestStreamingResponse({...defaultConfig,baseUrl:"https://example.com"},{model:"fixture"});
        expect(result.toolCalls).toMatchObject([{id:"call-1",function:{name:"read",arguments:"{}"}}]);
    });

    test("incomplete final JSON cannot replace existing content", async()=>{
        globalThis.fetch=(async()=>Response.json({...completed,status:"incomplete",incomplete_details:{reason:"max_output_tokens"}})) as typeof fetch;
        await expect(requestStreamingResponse({...defaultConfig,baseUrl:"https://example.com"},{model:"fixture"})).rejects.toThrow("token");
    });
});
