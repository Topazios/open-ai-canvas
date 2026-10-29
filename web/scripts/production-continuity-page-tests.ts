/** Real canvas route with isolated APIs. No real project writes or provider calls. */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeUnifiedWorkflowPlan } from "../test/fixtures/workflow-plan";
import { createCanvasPerformanceProject } from "../test/fixtures/canvas-performance-project";
import { defaultShortDramaSettings } from "../src/lib/short-drama-settings";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { assetContentSignature } from "../src/lib/canvas/canvas-workflow-asset-profile";
import { CanvasNodeType } from "../src/types/canvas";
import { layoutCanvasGridGroups } from "../src/lib/canvas/canvas-group-grid";
import { ProductionSoundKind } from "../src/lib/production-sound";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const dist = resolve("dist"), out = resolve("../.local/canvas-benchmark/production-continuity");
mkdirSync(out,{recursive:true});
const bundle = await Bun.build({ entrypoints:["src/lib/asset-sheet-compositor.ts"],target:"browser",minify:false });
if (!bundle.success) throw new Error("compositor browser bundle failed");
const compositor = await bundle.outputs[0].text();
const features = { welcomeEnabled:false,shortDramaEnabled:true,taskCenterEnabled:true,creditsEnabled:false,customChannelsEnabled:false,frontendModelsEnabled:false,pluginCenterEnabled:false };
const report = { passed:[] as string[],errors:[] as string[],blocked:[] as string[] };
const check = (ok:unknown,label:string) => { if (!ok) throw new Error(label); report.passed.push(label); };
let project:any, sequence=0;
const tasks:any[] = [];
const reply = (data:unknown) => Response.json({code:0,data,msg:""});
const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path==="/__test__/compositor.js") return new Response(compositor,{headers:{"Content-Type":"text/javascript"}});
    if(path.startsWith("/api/")) {
        const key=path.slice(4);
        if(key==="/auth/session") return reply({user:{id:"canvas-benchmark",username:"fixture",role:"user",status:"active"},features,runtimeLimits:{activeTaskLimit:20,resourceUploadMB:50,recycleBinRetentionDays:30,concurrency:{image:6,text:4,agent:4,video:2,audio:3,other:2,channel:12,customRelay:12,imagePreparation:4,resourceDownload:4,upload:4,mediaRecovery:2,agentSessions:4}}});
        if(key==="/features") return reply({features});
        if(key==="/model-catalog") return reply({source:"system",channels:[{id:"fixture",displayName:"Fixture",models:[{id:"audio",modelKey:"audio",displayName:"Fixture audio",capability:"audio",protocol:"openai-speech",available:true,priceTiers:[]}]}]});
        if(key===`/canvas-projects/${project?.id}`) {
            if(request.method==="PUT"){const input=await request.json();project={...input.project,revision:project.revision+1};}
            return reply({project});
        }
        if(key.endsWith("/variant-code")) return reply({code:`AUD-0001-V${String(++sequence).padStart(4,"0")}`});
        if(key.endsWith("/history")) return reply({snapshots:[],currentRevision:project.revision});
        if(key==="/user-data/snapshot") return reply({projects:[project],assets:[]});
        if(key==="/tasks" && request.method==="POST"){
            const input=await request.json();tasks.push(input);
            return reply({id:`fixture-task-${tasks.length}`,type:input.type,status:"queued",model:input.model,prompt:input.prompt,clientContext:{nodeId:input.input.metadata.nodeId},createdAt:new Date().toISOString()});
        }
        if(key==="/tasks") return reply([]);
        if(key.endsWith("/tasks/reconcile")) return reply({accepted:true});
        const fixtures:Record<string,unknown>={"/assets":{assets:[],total:0,hasMore:false,kindCounts:{},categoryCounts:{},folderCounts:{}},"/assets/batch":{assets:[]},"/projects":{projects:[],total:0},"/channels/system":{channels:[]},"/plugins":{plugins:[],states:{}},"/plugins/status":{statuses:{},states:{}},"/skills/added":{skills:[]},"/skills/presets":{presets:[]},"/skills":{skills:[],total:0},"/public/appearance":{appearance:{}},"/announcements":{announcements:[],unreadCount:0},"/banner-announcements":{banners:[]},"/settings/prompt-templates":{preferences:[]},"/agent/profile":{revision:"1",hash:"fixture",layers:[]}};
        if(key in fixtures) return reply(fixtures[key]);
        report.blocked.push(`${request.method} ${key}`);return Response.json({code:501,msg:"fixture blocked"},{status:501});
    }
    const filePath=resolve(dist,`.${decodeURIComponent(path)}`);
    if(filePath!==dist&&!filePath.startsWith(dist+sep)) return new Response(null,{status:403});
    const file=Bun.file(filePath);
    return new Response(filePath!==dist&&await file.exists()?file:Bun.file(join(dist,"index.html")));
}});
const origin=`http://127.0.0.1:${server.port}`;
const browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
try {
    for(const theme of ["dark","light"]){
        const pipeline=createShortDramaPipeline({x:0,y:0},true);
        pipeline.nodes[0].metadata!.content="选定故事与冲突";
        const pipelineId=nodeWorkflow(pipeline.nodes[0])!.pipelineId;
        const generated=createWorkflowDocuments({step:"story.plan",pipelineId,sourceNodeIds:[pipeline.nodes[0].id],model:"fixture::text",instruction:"",episodeCount:2,minutesPerEpisode:"1-2",start:1,count:1},pipeline.nodes,[],{x:0,y:0});
        const plan=completeUnifiedWorkflowPlan(generated);
        const sound=createCanvasNode(CanvasNodeType.Text,{x:0,y:0},{content:"## 声音核心设计与听觉辨识特征\n低沉而克制的成年声线。",status:"success",shortDrama:{...nodeWorkflow(plan.docs[1])!,assetIdentity:{id:"voice",code:"AUD-0001",kind:"sound"},assetProfile:{aliases:[],occurrences:[],variants:[],sounds:[],conflicts:[],references:[],indexContent:"",soundKind:ProductionSoundKind.Voice},planAsset:{key:"voice",name:"人物声线",kind:"sound",episodes:[1]}}});
        sound.title="人物声线"; sound.parentId=plan.frame.id;
        nodeWorkflow(sound)!.assetProfile!.indexContent=assetContentSignature(sound.metadata!.content!);
        nodeWorkflow(plan.frame)!.sourceNodeIds.push(sound.id); generated.nodes.push(sound);
        delete nodeWorkflow(plan.frame)!.planAbsent!.sound;
        const nodes=layoutCanvasGridGroups(generated.nodes);
        const focus=nodes.find(node=>node.id===sound.id)!;
        project={...createCanvasPerformanceProject(100),nodes,connections:generated.connections,projectId:"",globalSettings:defaultShortDramaSettings(),appearance:{mode:theme},viewport:{x:240-focus.position.x*0.8,y:180-focus.position.y*0.8,k:0.8}};
        const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:"block"});
        await context.addInitScript((theme:string)=>{if(location.protocol==="http:")localStorage.setItem("infinite-canvas:canvas-theme",JSON.stringify({state:{theme},version:0}));},theme);
        await context.route("**/*",(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
        const page=await context.newPage();page.setDefaultTimeout(12000);page.on("pageerror",(error:Error)=>report.errors.push(error.message));
        await page.goto(`${origin}/canvas/${project.id}`);
        const guide=page.getByRole("button",{name:"短剧流程",exact:true});await guide.waitFor();
        if(await guide.getAttribute("aria-pressed")==="true")await guide.click();
        const node=page.locator(`[data-node-id="${sound.id}"]`).first();
        await page.screenshot({path:join(out,`${theme}-canvas.png`)});
        await node.getByRole("button",{name:"资产资料",exact:true}).click();
        const review=page.getByRole("dialog");await review.getByRole("combobox",{name:"声音类别",exact:true}).waitFor();
        await review.getByRole("button",{name:"添加变体",exact:true}).click();
        await review.getByRole("textbox",{name:"变体1名称",exact:true}).fill("电话声线");
        await review.getByRole("textbox",{name:"变体1描述",exact:true}).fill("同一声线经电话带宽处理");
        await review.getByRole("button",{name:"保存资料",exact:true}).click();
        await review.getByRole("alert").filter({hasText:"来源依据"}).waitFor();
        for(const [name,value] of Object.entries({来源依据:"剧情通话",触发事件:"接听电话",前置状态:"自然声线",生效范围:"通话期间",结束或恢复条件:"挂断后恢复"})) await review.getByRole("textbox",{name:`变体1${name}`,exact:true}).fill(value);
        await review.getByRole("button",{name:"保存资料",exact:true}).click();await review.waitFor({state:"hidden"});
        await page.waitForTimeout(350);
        check(sequence>0,`${theme}: new state reserves a durable code after provenance validation`);
        await node.getByRole("button",{name:"生成试听",exact:true}).click();
        const panel=page.locator(".canvas-workflow-generator");await panel.waitFor();
        check(await panel.locator("label").filter({hasText:/^音频模型/}).count()===1,`${theme}: voice uses audio model selector`);
        check((await panel.getByRole("textbox",{name:"项目统一校准文本",exact:true}).inputValue()).length>20,`${theme}: shared language text is present`);
        check(await panel.getByRole("combobox",{name:"人物声线声线",exact:true}).count()===1,`${theme}: character voice is independently selectable`);
        await page.waitForTimeout(350);
        await page.screenshot({path:join(out,`${theme}-audio-desktop.png`)});
        await page.setViewportSize({width:390,height:740});
        check(await panel.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth+1),`${theme}: narrow panel has no horizontal overflow`);
        await page.screenshot({path:join(out,`${theme}-audio-mobile.png`)});
        await page.getByRole("button",{name:"关闭生成设置",exact:true}).click();
        const pixels=await page.evaluate(async()=>{
            const {compositeAssetSheet,assetSheetCells}=await import("/__test__/compositor.js");
            const input=document.createElement("canvas");input.width=1600;input.height=900;const ctx=input.getContext("2d")!;
            const colors=["#ff0000","#00ff00","#0000ff","#ff00ff","#00ffff","#ffff00","#880000","#008800"];
            colors.forEach((color,i)=>{ctx.fillStyle=color;ctx.fillRect(i%4*400,Math.floor(i/4)*450,400,450);});
            const output=await compositeAssetSheet(input.toDataURL(),{version:2,kind:"character",title:"人物统一设定板",code:"CHR-0001",size:"16:9",styleSignatures:{}});
            const bitmap=await createImageBitmap(await(await fetch(output)).blob());
            const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;const result=canvas.getContext("2d")!;result.drawImage(bitmap,0,0);
            return {width:bitmap.width,height:bitmap.height,centers:assetSheetCells().map((cell:any)=>Array.from(result.getImageData(cell.x+cell.width/2,cell.y+(cell.height-40)/2,1,1).data)),url:output};
        });
        check(pixels.width===1920&&pixels.height===1080&&pixels.centers.every((pixel:number[])=>pixel[3]===255)&&pixels.centers[0][0]===255&&pixels.centers[1][1]===255&&pixels.centers[2][2]===255,`${theme}: real browser composites ordered nonblank eight-cell sheet`);
        writeFileSync(join(out,`${theme}-sheet.png`),Buffer.from(pixels.url.split(",")[1],"base64"));
        await context.close();
    }
    check(tasks.length===0,"UI inspection never starts a paid generation");
    check(report.errors.length===0,"no browser runtime errors");
}finally{writeFileSync(join(out,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();server.stop(true);}
