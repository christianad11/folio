import AppKit

let output = CommandLine.arguments[1]
let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
NSGraphicsContext.current?.imageInterpolation = .high
let tile = NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 204, yRadius: 204)
NSGradient(starting: NSColor(srgbRed: 0.57, green: 0.46, blue: 0.36, alpha: 1), ending: NSColor(srgbRed: 0.39, green: 0.29, blue: 0.22, alpha: 1))!.draw(in: tile, angle: -90)
let book = NSBezierPath()
book.move(to: NSPoint(x: 512, y: 690))
book.curve(to: NSPoint(x: 258, y: 724), controlPoint1: NSPoint(x: 434, y: 746), controlPoint2: NSPoint(x: 352, y: 746))
book.line(to: NSPoint(x: 258, y: 332))
book.curve(to: NSPoint(x: 512, y: 306), controlPoint1: NSPoint(x: 350, y: 356), controlPoint2: NSPoint(x: 432, y: 356))
book.curve(to: NSPoint(x: 766, y: 332), controlPoint1: NSPoint(x: 592, y: 356), controlPoint2: NSPoint(x: 674, y: 356))
book.line(to: NSPoint(x: 766, y: 724))
book.curve(to: NSPoint(x: 512, y: 690), controlPoint1: NSPoint(x: 672, y: 746), controlPoint2: NSPoint(x: 590, y: 746))
book.line(to: NSPoint(x: 512, y: 306))
book.lineWidth = 25
book.lineCapStyle = .round
book.lineJoinStyle = .round
NSColor(srgbRed: 0.98, green: 0.95, blue: 0.89, alpha: 1).setStroke()
book.stroke()
NSGraphicsContext.restoreGraphicsState()
try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
