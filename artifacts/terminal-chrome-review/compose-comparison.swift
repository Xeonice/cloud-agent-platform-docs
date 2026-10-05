import AppKit
import CoreGraphics
import ImageIO
import Foundation

let outputRoot="artifacts/terminal-chrome-review/"
func image(_ file:String)->CGImage {
  guard let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:outputRoot+file) as CFURL,nil),let img=CGImageSourceCreateImageAtIndex(source,0,nil) else { fatalError("Cannot read "+file) }
  return img
}
func compare(_ leftFile:String,_ rightFile:String,_ output:String,_ leftTitle:String,_ rightTitle:String,_ note:String,_ cropHeight:Int) {
  let left=image(leftFile),rightSource=image(rightFile)
  guard let right=rightSource.cropping(to:CGRect(x:0,y:0,width:1184,height:cropHeight)) else {fatalError("crop failed")}
  precondition(left.width==1184 && left.height==cropHeight && right.width==1184 && right.height==cropHeight,"No rescaling is permitted")
  let width=2424,height=cropHeight+106
  guard let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:width,pixelsHigh:height,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:width*4,bitsPerPixel:32),let graphics=NSGraphicsContext(bitmapImageRep:rep) else {fatalError("bitmap failed")}
  NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=graphics
  let context=graphics.cgContext
  context.setFillColor(NSColor(calibratedWhite:0.09,alpha:1).cgColor);context.fill(CGRect(x:0,y:0,width:width,height:height))
  let titleAttrs:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:18,weight:.semibold),.foregroundColor:NSColor.white]
  let noteAttrs:[NSAttributedString.Key:Any]=[.font:NSFont.systemFont(ofSize:13),.foregroundColor:NSColor(calibratedWhite:0.72,alpha:1)]
  (leftTitle as NSString).draw(at:NSPoint(x:16,y:height-34),withAttributes:titleAttrs)
  (rightTitle as NSString).draw(at:NSPoint(x:1224,y:height-34),withAttributes:titleAttrs)
  context.draw(left,in:CGRect(x:16,y:height-54-cropHeight,width:1184,height:cropHeight))
  context.draw(right,in:CGRect(x:1224,y:height-54-cropHeight,width:1184,height:cropHeight))
  (note as NSString).draw(at:NSPoint(x:16,y:18),withAttributes:noteAttrs)
  NSGraphicsContext.restoreGraphicsState()
  guard let data=rep.representation(using:.png,properties:[:]) else {fatalError("encode failed")}
  try! data.write(to:URL(fileURLWithPath:outputRoot+output))
}
compare("draft-dark-1440-termbar.png","story-after-dark-1440-termbar.png","terminal-termbar-draft-vs-storybook.png","设计原稿 · f-wb-live-01","实际 Storybook · 当前终端栏","同 1440×900 深色视口；左右图均原始 1184×40 像素；未缩放、未变形。",40)
compare("production-before-dark-1440-topstrip.png","story-after-dark-1440-full.png","terminal-topstrip-before-vs-after.png","修复前 · 实际生产截图","修复后 · 实际 Storybook 装配","均截取原始 1184×144 像素。前：空菜单行＋标签＋重连提示＋独立工具行；后：标签与工具共一行。前为重连态，后为连接正常的空画布。",144)
