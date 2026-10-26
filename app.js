const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const LANG = { en:{sr:'en-US', code:'en', lbl:'EN'}, ko:{sr:'ko-KR', code:'ko', lbl:'KO'} };
let src='en', tgt='ko';
let rec=null, running=false, stream=null, mediaRec=null, chunks=[], audioBlob=null;
let t0=0, clockTimer=null, segStart=null, segments=[];
let sessionId=null, sessionAt=null;

function now(){ return t0 ? performance.now()-t0 : 0; }

function setDir(){
  $('srcLbl').textContent=LANG[src].lbl; $('tgtLbl').textContent=LANG[tgt].lbl;
  if(running && rec){ try{rec.stop()}catch(e){} } // onend가 새 언어로 재시작
}
$('swap').onclick=()=>{ [src,tgt]=[tgt,src]; setDir(); };

/* Claude 번역 (Supabase Edge Function, 스트리밍). onDelta(누적 번역문)로 자막을 실시간 갱신 */
async function translate(text, sl, tl, onDelta){
  const context=segments.filter(s=>s.done && s.sl===sl).slice(-5).map(s=>({orig:s.orig, trans:s.trans}));
  try{
    const {data:{session}}=await sb.auth.getSession();
    if(!session) return '[로그인이 만료되었습니다 – 새로고침 후 다시 로그인]';
    const r=await fetch(`${window.SUPABASE_URL}/functions/v1/translate`,{
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${session.access_token}`, apikey:window.SUPABASE_KEY},
      body:JSON.stringify({text, sl, tl, context})
    });
    if(!r.ok){ const j=await r.json().catch(()=>({})); return `[번역 실패 – ${j.error||r.status}]`; }
    const reader=r.body.getReader(), dec=new TextDecoder(); let out='';
    for(;;){ const {done,value}=await reader.read(); if(done) break; out+=dec.decode(value,{stream:true}); onDelta(out); }
    return out.trim();
  }catch(e){ return '[번역 실패 – 인터넷 연결 확인]'; }
}
function splitSentences(t){
  const parts=t.match(/[^.!?。？！]+[.!?。？！]*/g);
  return (parts||[t]).map(s=>s.trim()).filter(Boolean);
}

function addSegment(seg){
  $('empty')?.remove();
  const d=document.createElement('div'); d.className='seg';
  d.innerHTML=`<div class="t"></div><div class="o"></div><div class="tr"></div>`;
  d.querySelector('.t').textContent=fmt(seg.start);
  d.querySelector('.o').textContent=seg.orig;
  d.querySelector('.tr').textContent=seg.trans||'…';
  $('log').appendChild(d); seg.el=d;
  d.scrollIntoView({block:'end',behavior:'smooth'});
  updateButtons();
}

/* 기록 저장 (실패해도 통역은 계속) */
async function ensureSession(){
  if(sessionId) return;
  sessionAt=new Date();
  const {data,error}=await sb.from('sessions').insert({src, tgt, title:`통역 ${sessionAt.toLocaleString('ko-KR')}`}).select('id').single();
  if(error) console.error('세션 저장 실패',error); else sessionId=data.id;
}
function saveSegment(seg){
  if(!sessionId) return;
  sb.from('segments').insert({session_id:sessionId, start_ms:Math.round(seg.start), end_ms:Math.round(seg.end), sl:seg.sl, tl:seg.tl, orig:seg.orig, trans:seg.trans})
    .then(({error})=>{ if(error) console.error('문장 저장 실패',error); });
}

async function handleFinal(text){
  const start=segStart ?? now(), end=now(); segStart=null;
  const sentences=splitSentences(text);
  const span=(end-start)/sentences.length;
  const sl=LANG[src].code, tl=LANG[tgt].code;
  for(let i=0;i<sentences.length;i++){
    const seg={start:start+span*i, end:start+span*(i+1), sl, tl, orig:sentences[i], trans:'', done:false};
    segments.push(seg); addSegment(seg);
    $('liveO').textContent=seg.orig; $('liveO').classList.remove('interim');
    const isLatest=()=>segments[segments.length-1]===seg;
    translate(seg.orig, sl, tl, partial=>{
      seg.el.querySelector('.tr').textContent=partial;
      if(isLatest()) $('liveT').textContent=partial;
    }).then(tr=>{
      seg.trans=tr; seg.done=true; seg.el.querySelector('.tr').textContent=tr;
      if(isLatest()){ $('liveT').textContent=tr; $('liveO').textContent=seg.orig; }
      saveSegment(seg);
    });
  }
}

function startRecognition(){
  rec=new SR(); rec.lang=LANG[src].sr; rec.continuous=true; rec.interimResults=true;
  rec.onresult=e=>{
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const r=e.results[i], txt=r[0].transcript.trim();
      if(!txt) continue;
      if(segStart===null) segStart=now();
      if(r.isFinal) handleFinal(txt); else interim+=txt+' ';
    }
    if(interim){ $('liveO').textContent=interim; $('liveO').classList.add('interim'); }
  };
  rec.onerror=e=>{
    if(e.error==='not-allowed'||e.error==='service-not-allowed'){ alertMsg('음성 인식 권한이 거부되었습니다. 주소창 왼쪽 아이콘에서 마이크를 "허용"으로 바꾸고 새로고침해 주세요. 회사 PC에서는 음성 인식 서비스가 막혀 있을 수 있습니다.'); stop(); }
    else if(e.error==='network'){ alertMsg('음성 인식 서버에 연결하지 못했습니다. 인터넷 연결이나 회사 방화벽을 확인해 주세요.'); stop(); }
    else if(e.error==='audio-capture'){ alertMsg('마이크 입력을 받지 못했습니다. 마이크 연결을 확인해 주세요.'); stop(); }
  };
  rec.onend=()=>{ if(running) setTimeout(()=>{ if(running) startRecognition(); },200); };
  try{ rec.start(); }catch(e){}
}

function alertMsg(m){ $('liveO').textContent=m; $('liveT').textContent=''; }

async function start(){
  if(window.self!==window.top){ alertMsg('미리보기 창에서는 마이크를 쓸 수 없습니다. 사이트 주소를 Chrome 또는 Edge로 직접 열어 주세요.'); return; }
  if(!window.isSecureContext||/^content:/.test(location.protocol)){ alertMsg('https 주소가 아니면 브라우저가 보안상 마이크를 막습니다. https 주소로 열어 주세요.'); return; }
  if(!SR){ alertMsg('이 브라우저는 음성 인식을 지원하지 않습니다. PC의 Chrome 또는 Edge에서 열어 주세요.'); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){ alertMsg('이 방식으로 연 페이지에서는 마이크를 쓸 수 없습니다. Chrome 창에서 사이트 주소를 열어 주세요.'); return; }
  try{ stream=await navigator.mediaDevices.getUserMedia({audio:true}); }
  catch(e){
    const msg={
      NotAllowedError:'마이크 권한이 차단되어 있습니다. ① 주소창 왼쪽 아이콘 → 마이크 "허용" ② Windows 설정 → 개인 정보 → 마이크 → "데스크톱 앱의 마이크 액세스 허용" 켜기 후 새로고침해 주세요.',
      NotFoundError:'연결된 마이크를 찾지 못했습니다. 마이크나 헤드셋이 연결되어 있는지 확인해 주세요.',
      NotReadableError:'다른 프로그램(Teams, Zoom 등)이 마이크를 쓰고 있습니다. 그 프로그램을 닫고 다시 시도해 주세요.',
      SecurityError:'보안 정책 때문에 마이크가 막혀 있습니다. 회사 PC라면 IT팀 정책일 수 있습니다.'
    }[e.name]||`마이크를 열 수 없습니다 (${e.name}).`;
    alertMsg(msg); return;
  }
  running=true; chunks=[]; audioBlob=null;
  if(!t0 || segments.length===0) t0=performance.now();
  ensureSession();
  const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(m=>window.MediaRecorder&&MediaRecorder.isTypeSupported(m));
  mediaRec=new MediaRecorder(stream, mime?{mimeType:mime}:undefined);
  mediaRec.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  mediaRec.onstop=()=>{ audioBlob=new Blob(chunks,{type:mediaRec.mimeType||'audio/webm'}); updateButtons(); };
  mediaRec.start(1000);
  startRecognition();
  $('startBtn').textContent='■ 정지'; $('startBtn').classList.add('on'); $('dot').classList.add('rec');
  $('liveO').textContent='듣는 중…'; $('liveT').textContent='';
  clockTimer=setInterval(()=>$('clock').textContent=fmt(now()),500);
}
function stop(){
  running=false;
  try{rec&&rec.stop()}catch(e){}
  try{mediaRec&&mediaRec.state!=='inactive'&&mediaRec.stop()}catch(e){}
  stream&&stream.getTracks().forEach(t=>t.stop());
  clearInterval(clockTimer);
  $('startBtn').textContent='● 시작'; $('startBtn').classList.remove('on'); $('dot').classList.remove('rec');
  if(sessionId) sb.from('sessions').update({ended_at:new Date().toISOString()}).eq('id',sessionId).then(()=>{});
}
$('startBtn').onclick=()=> running?stop():start();

/* 다운로드 */
$('dlTxt').onclick=()=>exportTxt(segments);
$('dlSrt').onclick=()=>exportSrt(segments);
$('dlCsv').onclick=()=>exportCsv(segments);
$('dlAudio').onclick=()=>{ if(audioBlob) save(audioBlob,`통역녹음_${stamp()}.${audioBlob.type.includes('mp4')?'m4a':'webm'}`); };

function updateButtons(){
  const has=segments.length>0;
  ['dlTxt','dlSrt','dlCsv'].forEach(id=>$(id).disabled=!has);
  $('dlAudio').disabled=!audioBlob;
}

/* 기타 */
let clearArmed=false;
$('clearBtn').onclick=()=>{
  if(!clearArmed){ clearArmed=true; $('clearBtn').textContent='한 번 더 누르면 지움'; setTimeout(()=>{clearArmed=false;$('clearBtn').textContent='화면 지우기';},3000); return; }
  clearArmed=false; $('clearBtn').textContent='화면 지우기';
  segments=[]; $('log').innerHTML=''; if(!running){ t0=0; sessionId=null; $('clock').textContent='00:00:00'; } updateButtons();
};
$('size').onchange=e=>document.documentElement.style.setProperty('--sub-size',e.target.value+'px');
$('fsBtn').onclick=()=>{ document.body.classList.add('fs'); document.documentElement.requestFullscreen?.().catch(()=>{}); };
$('live').ondblclick=()=>{ document.body.classList.remove('fs'); if(document.fullscreenElement) document.exitFullscreen(); };
document.addEventListener('fullscreenchange',()=>{ if(!document.fullscreenElement) document.body.classList.remove('fs'); });
window.addEventListener('beforeunload',e=>{ if(running){ e.preventDefault(); e.returnValue=''; } });

requireLogin(()=>{ $('liveT').textContent='● 시작을 누르세요'; });
