"""หน้าเนียน: auto face mask + bilateral smoothing, whole clip, same length/fps/audio.
usage: python3 lib/reel/smooth.py <source> <out.mp4> [rot]   (rot = the clip's FilmCraft rotation, default -90)
Then relink the FilmCraft item to <out.mp4> (media.relink force). Always show
her a before/after face crop first; faces under ~100 px only change a little."""
import cv2,numpy as np,subprocess,sys
src,dst=sys.argv[1],sys.argv[2]
import os
rot=int(sys.argv[3]) if len(sys.argv)>3 else -90
fps=subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=r_frame_rate','-of','csv=p=0',src],capture_output=True,text=True).stdout.strip() or '50'
W,H=[int(v) for v in subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0:s=x',src],capture_output=True,text=True).stdout.strip().split('x')]
det=cv2.FaceDetectorYN.create(os.path.join(os.path.dirname(os.path.abspath(__file__)),'yunet.onnx'),'',(1080,1920),0.5)
rd=subprocess.Popen(['ffmpeg','-v','error','-i',src,'-f','rawvideo','-pix_fmt','bgr24','-'],stdout=subprocess.PIPE)
wr=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','bgr24','-s',f'{W}x{H}','-r',fps,'-i','-','-i',src,'-map','0:v','-map','1:a','-c:v','libx264','-crf','14','-preset','medium','-pix_fmt','yuv420p','-c:a','copy',dst],stdin=subprocess.PIPE)
prev=[]
while True:
    b=rd.stdout.read(W*H*3)
    if len(b)<W*H*3: break
    fr=np.frombuffer(b,np.uint8).reshape(H,W,3)
    p=cv2.rotate(fr,cv2.ROTATE_90_COUNTERCLOCKWISE) if rot==-90 else cv2.rotate(fr,cv2.ROTATE_90_CLOCKWISE) if rot==90 else fr
    det.setInputSize((p.shape[1],p.shape[0])); _,f=det.detect(p); faces=[tuple(map(int,x[:4])) for x in (f if f is not None else [])]
    if not faces: faces=prev
    prev=faces
    m=np.zeros(p.shape[:2],np.float32)
    for x,y,w,h in faces:
        cv2.ellipse(m,(x+w//2,y+int(h*0.55)),(int(w*0.62),int(h*0.68)),0,0,360,1,-1)
    if faces:
        m=cv2.GaussianBlur(m,(0,0),6)[...,None]*0.75
        sm=cv2.bilateralFilter(p,9,45,7); sm=cv2.bilateralFilter(sm,7,30,5)
        p=(p*(1-m)+sm*m).astype(np.uint8)
    wr.stdin.write((cv2.rotate(p,cv2.ROTATE_90_CLOCKWISE) if rot==-90 else cv2.rotate(p,cv2.ROTATE_90_COUNTERCLOCKWISE) if rot==90 else p).tobytes())
wr.stdin.close(); wr.wait()
