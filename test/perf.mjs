import { hostDir as host, hostDependencyPath } from './host.mjs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// Renderer-only fixture, even when invoked from a Herdr-managed shell.
process.env.PI_BTW_SURFACE = 'internal';
const td = hostDependencyPath('@earendil-works/pi-tui', 'dist');
const { createJiti } = await import(pathToFileURL(hostDependencyPath('jiti', 'lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { fsCache:false, alias:{ '@earendil-works/pi-tui':path.join(td,'index.js'), '@earendil-works/pi-coding-agent':path.join(host,'dist/index.js'), '@earendil-works/pi-ai':hostDependencyPath('@earendil-works/pi-ai', 'dist/index.js') } });
const { TuiAltScreen, ScrollView, VStack, Text, Markdown } = await import(pathToFileURL(path.join(td,'index.js')));
const { renderLayoutFrame } = await import(pathToFileURL(path.join(td,'layout.js')));
const { initTheme, getThemeByName, getMarkdownTheme } = await import(pathToFileURL(path.join(host,'dist/modes/interactive/theme/theme.js')));
initTheme('dark',false); const theme = getThemeByName('dark');
const commands=new Map(), events=new Map();
const { default: extension } = await jiti.import('../extensions/btw.ts');
extension({registerCommand:(n,v)=>commands.set(n,v), registerShortcut(){},registerMessageRenderer(){},on:(n,v)=>events.set(n,v),events:{emit(){}},appendEntry(){},getThinkingLevel:()=> 'off'});
let bytes=0; const terminal={columns:160,rows:40,write(s){bytes+=s.length},start(){},stop(){},hideCursor(){},showCursor(){}};
const tui=new TuiAltScreen(terminal);
let mainRenders=0;
const main=new Markdown(('## Main history\n\nLong text 中文 '.repeat(8)+'\n\n').repeat(80),0,0,getMarkdownTheme());
const mainRender = main.render.bind(main); main.render = width => { mainRenders++; return mainRender(width); };
const transcript=new ScrollView({children:[main],render(w){return main.render(w)},invalidate(){main.invalidate()}},{primary:true,follow:'end'});
tui.setLayoutRoot(new VStack([{component:transcript,basis:0,grow:1},new Text('EDITOR')]));
let overlay,handle;
const ctx={mode:'tui',hasUI:true,model:undefined,cwd:'/tmp',isIdle:()=>true,sessionManager:{getBranch:()=>[]},ui:{theme,setWidget(){},notify(){},custom:async(factory,opts)=>{
 let done,closed=false; const p=new Promise(r=>{done=(value)=>{closed=true;if(opts?.overlay){handle?.hide();overlay?.dispose()}r(value)}});
 const component=await factory(tui,theme,{matches:()=>false},done);
 if(!closed){overlay=component;handle=tui.showOverlay(component,opts.overlayOptions());opts.onHandle(handle)}
 return p;
}}};
function measure(name,run,n=20){const times=[];mainRenders=0;bytes=0;for(let i=0;i<n;i++){const t=performance.now();run(i);times.push(performance.now()-t)} times.sort((a,b)=>a-b); console.log(JSON.stringify({name,medianMs:+times[Math.floor(n/2)].toFixed(2),p95Ms:+times[Math.floor(n*.95)].toFixed(2),mainRenders,bytes}));}
const frame=()=>{const f=renderLayoutFrame(tui.layoutRoot,160,40,()=>{});tui.compositeOverlays(f.lines,160,40)};
measure('closed',frame);await commands.get('btw').handler('',ctx);await new Promise(r=>setImmediate(r));
overlay ??= tui.overlayStack.find(e=>e.component.constructor.name==='BtwOverlayComponent')?.component;
if(!overlay) throw Error('no BTW overlay');
const entries=Array.from({length:100},(_,i)=>({type:'assistant-text',text:`## Answer ${i}\n\n`+('A long **answer** with 中文 and code `x`.\n\n').repeat(12),streaming:false}));
overlay.readTranscriptEntries=()=>entries;overlay.refresh();frame();
measure('idle-sidebar',frame);
measure('typing-sidebar',i=>{overlay.setDraft('输入'+i);frame()});
measure('status-refresh',i=>{overlay.refresh();frame()});
measure('stream-sidebar',i=>{entries[99]={...entries[99],text:entries[99].text+' token',streaming:true};overlay.refresh();frame()});
await commands.get('btw:clear').handler('',ctx);
if (process.env.PI_STICKY_EXTENSION) {
const stickyHandlers=new Map();
const { default:sticky }=await jiti.import(path.resolve(process.env.PI_STICKY_EXTENSION));
sticky({on:(n,h)=>stickyHandlers.set(n,h)});
const stickyCtx={mode:'tui',hasUI:true,ui:{setWidget(_id,factory){factory?.(tui,theme)}}};
await stickyHandlers.get('session_start')({},stickyCtx);
measure('closed-sticky',frame);
await commands.get('btw').handler('',ctx);await new Promise(r=>setImmediate(r));
overlay=tui.overlayStack.find(e=>e.component.constructor.name==='BtwOverlayComponent')?.component;
overlay.readTranscriptEntries=()=>entries;overlay.refresh();frame();
measure('idle-sidebar-sticky',frame);
measure('typing-sidebar-sticky',i=>{overlay.setDraft('输入'+i);frame()});
measure('stream-sidebar-sticky',i=>{entries[99]={...entries[99],text:entries[99].text+' token'};overlay.refresh();frame()});
await commands.get('btw:clear').handler('',ctx);
await stickyHandlers.get('session_shutdown')({},stickyCtx);
}
