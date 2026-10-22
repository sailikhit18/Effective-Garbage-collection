// Demo-only screen switching
function go(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('on',s.id===id));
  document.querySelectorAll('.switcher button').forEach(b=>b.classList.toggle('on',b.dataset.s===id));
  window.scrollTo(0,0);
}
document.querySelectorAll('.switcher button').forEach(b=>b.onclick=()=>go(b.dataset.s));

// Demo-only worker timer (10 s stands in for 3-4 min)
const DEMO_SECONDS=10;let t=null;
document.getElementById('sim').onclick=()=>{
  clearInterval(t);let n=0;
  t=setInterval(()=>{
    n++;
    document.getElementById('timer').textContent='00:'+String(n).padStart(2,'0');
    document.getElementById('bar').style.width=(n/DEMO_SECONDS*100)+'%';
    if(n>=DEMO_SECONDS){
      clearInterval(t);
      const v=document.getElementById('st-visit');v.textContent='Street visited';v.className='badge b-visited';
      document.getElementById('confirm').disabled=false;
    }
  },1000);
};
document.getElementById('confirm').onclick=function(){
  const c=document.getElementById('st-coll');c.textContent='Collection confirmed';c.className='badge b-done';this.disabled=true;
};