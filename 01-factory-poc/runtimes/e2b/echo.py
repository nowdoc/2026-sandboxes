import http.server, json, os, sys
LOG=os.path.join(os.path.dirname(__file__), "state/echo.log")
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        rec={"src":self.client_address[0],"path":self.path,"headers":dict(self.headers)}
        open(LOG,"a").write(json.dumps(rec)+"\n")
        b=json.dumps(rec).encode(); self.send_response(200); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    do_POST=do_GET
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(("0.0.0.0",int(sys.argv[1])),H).serve_forever()
