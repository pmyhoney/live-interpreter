/* index.html·history.html 공용: Supabase 클라이언트, 로그인 게이트, 시간 형식, 내보내기 */
const $ = id => document.getElementById(id);
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);

function fmt(ms, srt){
  ms=Math.max(0,ms); const h=Math.floor(ms/3600000), m=Math.floor(ms/60000)%60, s=Math.floor(ms/1000)%60, r=Math.floor(ms%1000);
  const p=(n,l=2)=>String(n).padStart(l,'0');
  return `${p(h)}:${p(m)}:${p(s)}` + (srt?`,${p(r,3)}`:'');
}

/* 로그인: 세션이 없으면 #auth 오버레이를 띄우고, 로그인되면 onReady(user) 호출 */
function requireLogin(onReady){
  let ready=false;
  const show=on=>document.body.classList.toggle('locked',on);
  const enter=user=>{
    show(false); $('who').textContent=user.email;
    if(!ready){ ready=true; onReady(user); }
  };
  const msg=t=>$('authMsg').textContent=t;
  const creds=()=>({email:$('authEmail').value.trim(), password:$('authPw').value});
  $('authForm').onsubmit=async e=>{
    e.preventDefault(); msg('로그인 중…');
    const {data,error}=await sb.auth.signInWithPassword(creds());
    if(error) return msg(error.message==='Invalid login credentials'?'이메일 또는 비밀번호가 맞지 않습니다.':error.message);
    enter(data.user);
  };
  $('signupBtn').onclick=async()=>{
    const c=creds(); if(!c.email||c.password.length<6) return msg('이메일과 6자 이상 비밀번호를 입력해 주세요.');
    msg('가입 중…');
    const {data,error}=await sb.auth.signUp({...c, options:{emailRedirectTo:location.href}});
    if(error) return msg(error.message);
    if(data.session) enter(data.user); else msg('확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.');
  };
  $('logout').onclick=async()=>{ await sb.auth.signOut(); location.reload(); };

  /* 비밀번호 재설정: 메일 요청 → 메일 링크로 돌아오면 새 비밀번호 입력 */
  const forgot=document.createElement('button');
  forgot.type='button'; forgot.className='linkbtn'; forgot.textContent='비밀번호를 잊으셨나요?';
  $('authMsg').before(forgot);
  forgot.onclick=async()=>{
    const email=$('authEmail').value.trim();
    if(!email) return msg('이메일을 입력한 뒤 다시 눌러 주세요.');
    msg('재설정 메일 보내는 중…');
    const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
    msg(error?(/rate limit/i.test(error.message)?'메일을 너무 자주 요청했습니다. 잠시 후 다시 시도해 주세요.':error.message)
             :'재설정 메일을 보냈습니다. 메일의 링크를 눌러 새 비밀번호를 정해 주세요.');
  };
  const resetForm=document.createElement('form');
  resetForm.id='resetForm'; resetForm.hidden=true;
  resetForm.innerHTML=`<h2>새 비밀번호 설정</h2>
    <input id="newPw" type="password" placeholder="새 비밀번호 (6자 이상)" autocomplete="new-password" required minlength="6">
    <input id="newPw2" type="password" placeholder="새 비밀번호 확인" autocomplete="new-password" required minlength="6">
    <button type="submit" class="primary">비밀번호 변경</button>
    <span class="note" id="resetMsg"></span>`;
  $('auth').append(resetForm);
  const recovering=/type=recovery/.test(location.hash);
  const showReset=()=>{ show(true); $('authForm').hidden=true; resetForm.hidden=false; $('newPw').focus(); };
  resetForm.onsubmit=async e=>{
    e.preventDefault();
    const pw=$('newPw').value;
    if(pw!==$('newPw2').value) return $('resetMsg').textContent='두 비밀번호가 다릅니다.';
    $('resetMsg').textContent='변경 중…';
    const {data,error}=await sb.auth.updateUser({password:pw});
    if(error) return $('resetMsg').textContent=error.message;
    history.replaceState(null,'',location.pathname);
    resetForm.hidden=true; $('authForm').hidden=false;
    enter(data.user);
  };
  sb.auth.onAuthStateChange(ev=>{ if(ev==='PASSWORD_RECOVERY') showReset(); });

  sb.auth.getSession().then(({data})=>{
    if(recovering && data.session) showReset();
    else if(data.session) enter(data.session.user); else show(true);
  });
}

/* 내보내기 */
function stamp(d=new Date()){ const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
function save(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000); }
const BOM='﻿';
function exportTxt(segs, when=new Date()){
  const t=segs.map(s=>`[${fmt(s.start)}] (${s.sl.toUpperCase()}) ${s.orig}\n           (${s.tl.toUpperCase()}) ${s.trans}`).join('\n\n');
  save(new Blob([BOM+`실시간 통역 기록 ${when.toLocaleString('ko-KR')}\n\n`+t],{type:'text/plain;charset=utf-8'}),`통역기록_${stamp(when)}.txt`);
}
function exportSrt(segs, when=new Date()){
  const t=segs.map((s,i)=>`${i+1}\n${fmt(s.start,1)} --> ${fmt(Math.max(s.end,s.start+1500),1)}\n${s.orig}\n${s.trans}\n`).join('\n');
  save(new Blob([BOM+t],{type:'text/plain;charset=utf-8'}),`통역자막_${stamp(when)}.srt`);
}
function exportCsv(segs, when=new Date()){
  const q=v=>`"${String(v).replace(/"/g,'""')}"`;
  const rows=[['시작','종료','원문 언어','원문','번역 언어','번역']].concat(segs.map(s=>[fmt(s.start),fmt(s.end),s.sl,s.orig,s.tl,s.trans]));
  save(new Blob([BOM+rows.map(r=>r.map(q).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),`통역기록_${stamp(when)}.csv`);
}
