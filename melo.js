/* Continuous GPU interpolation of isolated sprite cells. No neighbouring frame can bleed in. */
(() => {
  'use strict';
  const vertex = `attribute vec2 p;varying vec2 uv;void main(){uv=(p+1.)*.5;gl_Position=vec4(p.x,-p.y,0.,1.);}`;
  const fragment = `precision mediump float;
    varying vec2 uv;uniform sampler2D sheet;uniform float progress;uniform float mode;
    vec2 paw(float f){if(f<.5)return vec2(.875,.51);if(f<1.5)return vec2(.94,.65);if(f<2.5)return vec2(.95,.84);return vec2(.94,.65);}
    vec4 cell(float f,vec2 q){q=clamp(q,vec2(.006,.003),vec2(.994,.997));return texture2D(sheet,vec2((f+q.x)*.25,q.y));}
    vec2 deform(vec2 q,vec2 from,vec2 to){vec2 delta=to-from;float w=exp(-dot((q-to)/vec2(.15,.18),(q-to)/vec2(.15,.18))*1.9);float zone=smoothstep(.66,.76,q.x)*smoothstep(.37,.48,q.y)*(1.-smoothstep(.82,.94,q.y));return q-delta*w*zone;}
    void main(){
      vec4 base=cell(0.,uv);vec4 color=base;
      if(mode<1.5){
        float t=clamp(progress,0.,1.)*4.;float seg=min(floor(t),3.);float k=smoothstep(0.,1.,fract(t));
        float a=seg;float b=seg+1.;if(b>3.5)b=0.;
        vec2 target=mix(paw(a),paw(b),k);
        vec4 first=cell(a,deform(uv,paw(a),target));vec4 second=cell(b,deform(uv,paw(b),target));
        vec4 moving=mix(first,second,k);
        // Head, body and tail stay on the clean neutral frame throughout the movement.
        float area=smoothstep(.66,.77,uv.x)*smoothstep(.39,.48,uv.y)*(1.-smoothstep(.88,.97,uv.y));
        color=mix(base,moving,area);
      }else{
        float envelope=sin(3.14159265*clamp(progress,0.,1.));
        vec2 target=paw(0.)+vec2(sin(progress*18.84956)*.045*envelope,-.075*envelope);
        color=cell(0.,deform(uv,paw(0.),target));
      }
      gl_FragColor=color;
    }`;
  let image,ready=false,mode='switch',start=0,duration=1200,raf=0;
  const views=[];
  function shader(gl,type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('shader');return s}
  function makeView(el){
    const canvas=document.createElement('canvas');canvas.className='melo-motion-canvas';canvas.width=540;canvas.height=720;canvas.setAttribute('aria-hidden','true');
    const gl=canvas.getContext('webgl',{alpha:false,antialias:false,preserveDrawingBuffer:false});if(!gl)return null;
    const program=gl.createProgram();gl.attachShader(program,shader(gl,gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl,gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))return null;
    gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const pos=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);
    const progress=gl.getUniformLocation(program,'progress'),kind=gl.getUniformLocation(program,'mode');gl.uniform1i(gl.getUniformLocation(program,'sheet'),0);
    el.append(canvas);return{el,canvas,gl,program,progress,kind};
  }

  const frames=[];
  function ease(x){return x*x*(3-2*x)}
  const paws=[[.875,.51],[.94,.65],[.95,.84],[.94,.65]];
  function cpuView(el){const canvas=document.createElement('canvas');canvas.className='melo-motion-canvas';canvas.width=360;canvas.height=480;canvas.setAttribute('aria-hidden','true');const ctx=canvas.getContext('2d');if(!ctx)return null;
    const layer=document.createElement('canvas');layer.width=360;layer.height=480;const lc=layer.getContext('2d');
    const mask=document.createElement('canvas');mask.width=360;mask.height=480;const mc=mask.getContext('2d');mc.save();mc.scale(360,480);mc.translate(.88,.67);mc.scale(.24,.31);const gradient=mc.createRadialGradient(0,0,.40,0,0,1);gradient.addColorStop(0,'#fff');gradient.addColorStop(1,'#fff0');mc.fillStyle=gradient;mc.fillRect(-1,-1,2,2);mc.restore();el.append(canvas);return{el,canvas,ctx,layer,lc,mask,cpu:true};}
  function triangle(ctx,frame,s,d,opacity){
    const [a,b,c]=s,[u,v,w]=d;
    const den=a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1]);if(Math.abs(den)<.00001)return;
    function coeff(axis){const x=u[axis],y=v[axis],z=w[axis];return[(x*(b[1]-c[1])+y*(c[1]-a[1])+z*(a[1]-b[1]))/den,(x*(c[0]-b[0])+y*(a[0]-c[0])+z*(b[0]-a[0]))/den,(x*(b[0]*c[1]-c[0]*b[1])+y*(c[0]*a[1]-a[0]*c[1])+z*(a[0]*b[1]-b[0]*a[1]))/den]}
    const x=coeff(0),y=coeff(1);ctx.save();ctx.globalAlpha=opacity;ctx.beginPath();ctx.moveTo(u[0],u[1]);ctx.lineTo(v[0],v[1]);ctx.lineTo(w[0],w[1]);ctx.closePath();ctx.clip();ctx.transform(x[0],y[0],x[1],y[1],x[2],y[2]);ctx.drawImage(frame,0,0);ctx.restore();
  }
  function warp(v,index,target,alpha){if(alpha<.001)return;const W=360,H=480,N=16,M=22,paw=paws[index];
    function point(x,y){const qx=x/N,qy=y/M;const g=Math.exp(-(((qx-paw[0])/.15)**2+((qy-paw[1])/.18)**2)*1.9);const zone=Math.min(1,Math.max(0,(qx-.66)/.1))*Math.min(1,Math.max(0,(qy-.37)/.11))*Math.min(1,Math.max(0,(.94-qy)/.12));return[(qx+(target[0]-paw[0])*g*zone)*W,(qy+(target[1]-paw[1])*g*zone)*H]}
    for(let y=7;y<M;y++)for(let x=10;x<N;x++){const a=[x*W/N,y*H/M],b=[(x+1)*W/N,y*H/M],c=[x*W/N,(y+1)*H/M],d=[(x+1)*W/N,(y+1)*H/M];const aa=point(x,y),bb=point(x+1,y),cc=point(x,y+1),dd=point(x+1,y+1);triangle(v.lc,frames[index],[a,b,c],[aa,bb,cc],alpha);triangle(v.lc,frames[index],[b,d,c],[bb,dd,cc],alpha)}
  }
  function cpuPaint(v,t){v.ctx.clearRect(0,0,360,480);v.ctx.drawImage(frames[0],0,0);v.lc.clearRect(0,0,360,480);v.lc.globalCompositeOperation='source-over';
    if(mode==='wave'){const envelope=Math.sin(Math.PI*t);warp(v,0,[paws[0][0]+Math.sin(t*Math.PI*6)*.045*envelope,paws[0][1]-.075*envelope],1)}
    else{const scaled=Math.min(t*.999999,0.999999)*4,a=Math.floor(scaled),b=(a+1)%4,k=ease(scaled-a);const target=[paws[a][0]*(1-k)+paws[b][0]*k,paws[a][1]*(1-k)+paws[b][1]*k];warp(v,a,target,1);warp(v,b,target,k)}
    v.lc.globalCompositeOperation='destination-in';v.lc.drawImage(v.mask,0,0);v.lc.globalCompositeOperation='source-over';v.ctx.drawImage(v.layer,0,0);
  }

  function paint(t){for(const v of views){if(v.cpu){cpuPaint(v,t);continue}v.gl.useProgram(v.program);v.gl.uniform1f(v.progress,t);v.gl.uniform1f(v.kind,mode==='wave'?2:1);v.gl.drawArrays(v.gl.TRIANGLES,0,6)}}
  function finish(){cancelAnimationFrame(raf);raf=0;for(const v of views)v.el.classList.remove('has-motion');}
  function tick(now){const t=Math.min(1,(now-start)/duration);paint(t);if(t<1)raf=requestAnimationFrame(tick);else finish()}
  function play(kind){
    finish();mode=kind;
    if(!ready||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    duration=kind==='wave'?1600:1200;start=performance.now();for(const v of views)v.el.classList.add('has-motion');paint(0);raf=requestAnimationFrame(tick);
  }
  window.MeloMotion={play,stop:finish};
  image=new Image();image.onload=()=>{for(let i=0;i<4;i++){const f=document.createElement('canvas');f.width=360;f.height=480;f.getContext('2d').drawImage(image,i*image.width/4,0,image.width/4,image.height,0,0,360,480);frames.push(f)}document.querySelectorAll('.melo-3d-sprite').forEach(el=>{try{const v=makeView(el)||cpuView(el);if(v)views.push(v)}catch{const v=cpuView(el);if(v)views.push(v)}});ready=views.length>0};image.src='assets/melo-3d.webp';
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish()});
})();
