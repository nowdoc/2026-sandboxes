import http.server,sys,json
host,port=sys.argv[1],int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        rec={"peer":self.client_address[0],"path":self.path,"headers":dict(self.headers)}
        open(__import__("os").path.join(__import__("os").path.dirname(__file__), "echo.log"),"a").write(f"{port} {json.dumps(rec)}\n")
        b=json.dumps(rec).encode();self.send_response(200);self.send_header("Content-Length",str(len(b)));self.end_headers();self.wfile.write(b)
    do_POST=do_GET
    def log_message(self,*a):pass
http.server.ThreadingHTTPServer((host,port),H).serve_forever()
