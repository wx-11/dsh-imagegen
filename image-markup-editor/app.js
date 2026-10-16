const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d');
const wrap = document.querySelector('#canvasWrap');
const emptyState = document.querySelector('#emptyState');
const state = { image:null, objects:[], selected:null, tool:'select', color:'#ef4444', size:8, drawing:null, history:[], future:[] };
const clone = value => JSON.parse(JSON.stringify(value));
function snapshot(){ return clone(state.objects); }
function commit(){ state.history.push(snapshot()); if(state.history.length>80) state.history.shift(); state.future=[]; updateHistoryButtons(); }
function restore(objects){ state.objects=clone(objects); state.selected=null; render(); }
function updateHistoryButtons(){ undoButton.disabled=!state.history.length; redoButton.disabled=!state.future.length; }
function fitCanvas(){ if(!state.image){canvas.width=1;canvas.height=1;return} canvas.width=state.image.naturalWidth; canvas.height=state.image.naturalHeight; render(); }
function render(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(state.image) ctx.drawImage(state.image,0,0);
  for(const o of state.objects){ if(o.type==='stroke') drawStroke(o); else if(o.type==='rect') drawRect(o); else if(o.type==='text') drawText(o); }
  if(state.selected){ const o=state.objects.find(x=>x.id===state.selected); if(o) drawSelection(o); }
  emptyState.hidden=!!state.image; objectCount.textContent=state.objects.length; dimensions.textContent=state.image?`${canvas.width} x ${canvas.height}`:'-'; statusText.textContent=state.image?'已加载图片':'未加载图片'; selectionInfo.textContent=state.selected?'已选择标注对象':'选择一个标注对象';
}
function drawStroke(o){ctx.save();ctx.globalCompositeOperation=o.tool==='eraser'?'destination-out':'source-over';ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();o.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.restore()}
function drawRect(o){ctx.save();ctx.strokeStyle=o.color;ctx.lineWidth=o.size;ctx.strokeRect(o.x,o.y,o.w,o.h);ctx.restore()}
function drawText(o){ctx.save();ctx.fillStyle=o.color;ctx.font=`600 ${o.size*4+12}px sans-serif`;ctx.fillText(o.text,o.x,o.y);ctx.restore()}
function bounds(o){if(o.type==='stroke'){const xs=o.points.map(p=>p.x),ys=o.points.map(p=>p.y);return{x:Math.min(...xs)-o.size,y:Math.min(...ys)-o.size,w:Math.max(...xs)-Math.min(...xs)+o.size*2,h:Math.max(...ys)-Math.min(...ys)+o.size*2}}if(o.type==='text')return{x:o.x,y:o.y-o.size*4-12,w:Math.max(30,o.text.length*o.size*2),h:o.size*4+16};return{x:Math.min(o.x,o.x+o.w)-o.size,y:Math.min(o.y,o.y+o.h)-o.size,w:Math.abs(o.w)+o.size*2,h:Math.abs(o.h)+o.size*2}}
function drawSelection(o){const b=bounds(o);ctx.save();ctx.strokeStyle='#2563eb';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(b.x,b.y,b.w,b.h);ctx.restore()}
function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}}
function hit(p){for(let i=state.objects.length-1;i>=0;i--){const b=bounds(state.objects[i]);if(p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h)return state.objects[i]}return null}
function pointerDown(e){if(!state.image)return;canvas.setPointerCapture(e.pointerId);const p=point(e);if(state.tool==='pen'||state.tool==='eraser'){commit();state.drawing={type:'stroke',id:crypto.randomUUID(),tool:state.tool,color:state.color,size:state.size,points:[p]};state.objects.push(state.drawing)}else if(state.tool==='rect'){commit();state.drawing={type:'rect',id:crypto.randomUUID(),color:state.color,size:state.size,x:p.x,y:p.y,w:0,h:0};state.objects.push(state.drawing)}else if(state.tool==='select'){const o=hit(p);state.selected=o?.id??null;if(o){commit();state.drawing={type:'move',object:o,last:p}}}render()}
function pointerMove(e){if(!state.drawing)return;const p=point(e);if(state.drawing.type==='stroke')state.drawing.points.push(p);else if(state.drawing.type==='rect'){state.drawing.w=p.x-state.drawing.x;state.drawing.h=p.y-state.drawing.y}else if(state.drawing.type==='move'){const o=state.drawing.object;o.x+=p.x-state.drawing.last.x;o.y+=p.y-state.drawing.last.y;state.drawing.last=p}render()}
function pointerUp(e){if(!state.drawing)return;if(state.drawing.type==='stroke'&&state.drawing.points.length===1)state.drawing.points.push({...state.drawing.points[0],x:state.drawing.points[0].x+.1});state.drawing=null;render()}
canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{state.tool=b.dataset.tool;document.querySelectorAll('.tool').forEach(x=>x.classList.toggle('active',x===b));canvas.style.cursor=state.tool==='select'?'default':state.tool==='text'?'text':'crosshair'});
colorInput.oninput=e=>state.color=e.target.value;sizeInput.oninput=e=>{state.size=+e.target.value;sizeOutput.value=state.size};
fileInput.onchange=e=>{const file=e.target.files[0];if(!file)return;const img=new Image();img.onload=()=>{state.image=img;state.objects=[];state.history=[];state.future=[];fitCanvas();updateHistoryButtons()};img.src=URL.createObjectURL(file)};
canvas.ondblclick=e=>{if(state.tool!=='text'||!state.image)return;const p=point(e),text=prompt('输入文字');if(text){commit();state.objects.push({type:'text',id:crypto.randomUUID(),text,x:p.x,y:p.y,color:state.color,size:state.size});render()}};
undoButton.onclick=()=>{if(!state.history.length)return;state.future.push(snapshot());restore(state.history.pop());updateHistoryButtons()};redoButton.onclick=()=>{if(!state.future.length)return;state.history.push(snapshot());restore(state.future.pop());updateHistoryButtons()};
clearButton.onclick=()=>{if(!state.objects.length)return;commit();state.objects=[];state.selected=null;render()};
exportButton.onclick=()=>{if(!state.image)return;const a=document.createElement('a');a.download='annotated-image.png';a.href=canvas.toDataURL('image/png');a.click()};
window.addEventListener('resize',render);render();
