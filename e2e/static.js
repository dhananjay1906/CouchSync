const http=require('http'),fs=require('fs'),path=require('path');
const root=path.join(__dirname,'site');
http.createServer((req,res)=>{
  const p=path.join(root,decodeURIComponent(new URL(req.url,'http://x').pathname));
  if(!p.startsWith(root)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){res.writeHead(404);return res.end();}
  const size=fs.statSync(p).size, type=p.endsWith('.webm')?'video/webm':'text/html';
  const r=req.headers.range&&/bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if(r){const s=r[1]?+r[1]:0,e=r[2]?+r[2]:size-1;res.writeHead(206,{'Content-Type':type,'Accept-Ranges':'bytes','Content-Range':`bytes ${s}-${e}/${size}`,'Content-Length':e-s+1});return fs.createReadStream(p,{start:s,end:e}).pipe(res);}
  res.writeHead(200,{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':size});fs.createReadStream(p).pipe(res);
}).listen(+process.argv[2]||8800);
