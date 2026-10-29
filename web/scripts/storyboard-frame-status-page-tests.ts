/** Verify the production canvas route with isolated APIs; never call a model. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createCanvasNode, createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { CanvasNodeType } from "../src/types/canvas";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist"), out = resolve("../.local/canvas-benchmark/storyboard-frame-status");
mkdirSync(out, { recursive:true });
const report = { passed:[] as string[], errors:[] as string[], blocked:[] as string[] };
const check = (ok:unknown, label:string) => { if (!ok) throw new Error(label); report.passed.push(label); };
const features = { welcomeEnabled:false, shortDramaEnabled:true, taskCenterEnabled:true, creditsEnabled:false, customChannelsEnabled:false, frontendModelsEnabled:false, pluginCenterEnabled:false };
let project:any;
const reply = (data:unknown) => Response.json({ code:0, data, msg:"" });
const server = Bun.serve({ hostname:"127.0.0.1", port:0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
        const key = path.slice(4);
        if (key === "/auth/session") return reply({ user:{id:"canvas-benchmark",username:"fixture",role:"user",status:"active"}, features, runtimeLimits:{activeTaskLimit:20,resourceUploadMB:50,concurrency:{image:6,text:4,agent:4,video:2,audio:3,other:2,channel:12,customRelay:12,imagePreparation:4,resourceDownload:4,upload:4,mediaRecovery:2,agentSessions:4}} });
        if (key === "/features") return reply({ features });
        if (key === "/model-catalog") return reply({ source:"system", channels:[] });
        if (key === `/canvas-projects/${project.id}`) {
            if (request.method === "PUT") { const input = await request.json(); project = {...input.project,revision:project.revision+1}; }
            return reply({project});
        }
        if (key.endsWith("/history")) return reply({snapshots:[],currentRevision:project.revision});
        if (key === "/user-data/snapshot") return reply({projects:[project],assets:[]});
        if (key.endsWith("/tasks/reconcile")) return reply({accepted:true});
        const fixtures:Record<string,unknown> = { "/tasks":[], "/assets":{assets:[],total:0,hasMore:false,kindCounts:{},categoryCounts:{},folderCounts:{}}, "/assets/batch":{assets:[]}, "/projects":{projects:[],total:0}, "/channels/system":{channels:[]}, "/plugins":{plugins:[],states:{}}, "/plugins/status":{statuses:{},states:{}}, "/skills/added":{skills:[]}, "/skills/presets":{presets:[]}, "/skills":{skills:[],total:0}, "/public/appearance":{appearance:{}}, "/announcements":{announcements:[],unreadCount:0}, "/banner-announcements":{banners:[]}, "/settings/prompt-templates":{preferences:[]}, "/agent/profile":{revision:"1",hash:"fixture",layers:[]} };
        if (key in fixtures && request.method === "GET") return reply(fixtures[key]);
        report.blocked.push(`${request.method} ${key}`);
        return Response.json({code:501,msg:"unexpected fixture request"},{status:501});
    }
    const filePath = resolve(dist, `.${decodeURIComponent(path)}`);
    if (filePath !== dist && !filePath.startsWith(dist+sep)) return new Response(null,{status:403});
    const file = Bun.file(filePath);
    return new Response(filePath !== dist && await file.exists() ? file : Bun.file(join(dist,"index.html")));
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
try {
    for (const theme of ["dark","light"]) {
        const row = createStoryboardRow(1,{shotCode:"EP01-S01-001",durationSeconds:12,videoMotionPrompt:"人物推门走入房间。"});
        const data = {pipelineId:"p",stage:"storyboard" as const,step:"direction.shots" as const,role:"document" as const,sourceNodeIds:[],sourceSignatures:{},productionAgent:{},submission:"planned" as const};
        const shots = createCanvasNode(CanvasNodeType.Script,{x:0,y:0},{status:"success",storyboard:{rows:[row],visibleColumns:[],referenceNodeIds:[]},shortDrama:{...data,submission:"submitted",episodeNumber:1}});
        shots.width=1280; shots.height=820;
        const pending = createCanvasNode(CanvasNodeType.Script,{x:1340,y:0},{status:"idle",storyboard:{rows:[],visibleColumns:[],referenceNodeIds:[]},shortDrama:{...data,episodeNumber:2}});
        pending.width=1280; pending.height=820;
        project={...createCanvasPerformanceProject(100),nodes:[shots,pending],connections:[],viewport:{x:100,y:150,k:0.48},appearance:{mode:theme}};
        const context = await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:"block"});
        await context.addInitScript((theme:string)=>localStorage.setItem("infinite-canvas:canvas-theme",JSON.stringify({state:{theme},version:0})),theme);
        await context.route("**/*", (route:any)=>new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on("pageerror",(error:Error)=>report.errors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const guide = page.getByRole("button",{name:"短剧流程",exact:true}); await guide.waitFor();
        if (await guide.getAttribute("aria-pressed")==="true") await guide.click();
        const stack = page.locator(".canvas-storyboard-image-stack-pending").first(); await stack.waitFor();
        check((await stack.textContent())?.includes("待生成 2"),`${theme}: untouched boundaries say pending generation`);
        check(await stack.getAttribute("data-failed")==="false",`${theme}: untouched boundaries do not show failure`);
        check(await page.getByText("本集尚未提交，请在分组详情中继续提交",{exact:true}).count()===1,`${theme}: unsubmitted episode never claims to be planning`);
        await page.screenshot({path:join(out,`${theme}-desktop.png`)});
        await page.setViewportSize({width:390,height:740});
        check(await page.locator(".canvas-storyboard-image-stack-pending[data-failed=false]").count()===1,`${theme}: narrow canvas retains the neutral status`);
        await page.screenshot({path:join(out,`${theme}-mobile.png`)});
        await context.close();
    }
    check(report.errors.length===0&&report.blocked.length===0,"no runtime errors, model calls or unexpected requests");
} finally {
    writeFileSync(join(out,"report.json"),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
    await browser.close(); server.stop(true);
}
