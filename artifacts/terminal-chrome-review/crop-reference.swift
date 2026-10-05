import Foundation
import ImageIO
import CoreGraphics
func crop(_ from:String,_ to:String,_ rect:CGRect) {
  guard let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:from) as CFURL,nil),let sourceImage=CGImageSourceCreateImageAtIndex(source,0,nil),let image=sourceImage.cropping(to:rect),let destination=CGImageDestinationCreateWithURL(URL(fileURLWithPath:to) as CFURL,"public.png" as CFString,1,nil) else {fatalError("crop failed")}
  CGImageDestinationAddImage(destination,image,nil)
  guard CGImageDestinationFinalize(destination) else {fatalError("write failed")}
}
crop("artifacts/design-shell-project-v2-v3-dark1440/f-wb-live-01-dark-1440-terminal-reconnecting.png","artifacts/terminal-chrome-review/production-before-dark-1440-topstrip.png",CGRect(x:256,y:106,width:1184,height:144))
crop("artifacts/terminal-chrome-review/tabs-before.png","artifacts/terminal-chrome-review/story-before-dark-requested-1200-tabs-crop.png",CGRect(x:16,y:16,width:1168,height:40))
crop("artifacts/terminal-chrome-review/tabs-after.png","artifacts/terminal-chrome-review/story-after-dark-1200-tabs-crop.png",CGRect(x:16,y:16,width:1168,height:40))
crop("artifacts/terminal-chrome-review/toolbar-before.png","artifacts/terminal-chrome-review/story-before-dark-requested-1200-toolbar-crop.png",CGRect(x:16,y:16,width:1168,height:28))
crop("artifacts/terminal-chrome-review/toolbar-after.png","artifacts/terminal-chrome-review/story-after-dark-1200-toolbar-crop.png",CGRect(x:16,y:16,width:1168,height:28))
crop("artifacts/terminal-chrome-review/pane-before.png","artifacts/terminal-chrome-review/story-before-dark-requested-1200-canvas-crop.png",CGRect(x:0,y:0,width:1200,height:320))
crop("artifacts/terminal-chrome-review/pane-after.png","artifacts/terminal-chrome-review/story-after-dark-1200-canvas-crop.png",CGRect(x:0,y:0,width:1200,height:320))
