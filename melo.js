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
  function paint(t){for(const v of views){v.gl.useProgram(v.program);v.gl.uniform1f(v.progress,t);v.gl.uniform1f(v.kind,mode==='wave'?2:1);v.gl.drawArrays(v.gl.TRIANGLES,0,6)}}
  function finish(){cancelAnimationFrame(raf);raf=0;for(const v of views)v.el.classList.remove('has-motion');}
  function tick(now){const t=Math.min(1,(now-start)/duration);paint(t);if(t<1)raf=requestAnimationFrame(tick);else finish()}
  function play(kind){
    finish();mode=kind;
    if(!ready||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    duration=kind==='wave'?1600:1200;start=performance.now();for(const v of views)v.el.classList.add('has-motion');paint(0);raf=requestAnimationFrame(tick);
  }
  window.MeloMotion={play,stop:finish};
  image=new Image();image.onload=()=>{document.querySelectorAll('.melo-3d-sprite').forEach(el=>{try{const v=makeView(el);if(v)views.push(v)}catch{}});ready=views.length>0};image.src='assets/melo-3d.webp';
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finish()});
})();
