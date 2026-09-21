import CoreGraphics
import ImageIO
import SwiftUI
import XCTest
@testable import ThinkingOrbsKit

/// Exercise the real SwiftUI Canvas renderer, not just the geometry engine.
@available(iOS 16.0, macOS 13.0, *)
final class OrbRenderingTests: XCTestCase {
    private struct Raster: Equatable {
        let width: Int
        let height: Int
        let rgba: [UInt8]

        var visiblePixels: Int {
            stride(from: 3, to: rgba.count, by: 4).filter { rgba[$0] > 0 }.count
        }
        var alpha: [UInt8] {
            stride(from: 3, to: rgba.count, by: 4).map { rgba[$0] }
        }
    }

    @MainActor
    private func image<V: View>(_ content: V, scale: Double = 2) throws -> CGImage {
        let renderer = ImageRenderer(content: content)
        renderer.scale = scale
        renderer.isOpaque = false
        return try XCTUnwrap(renderer.cgImage, "SwiftUI failed to render the orb")
    }

    @MainActor
    private func raster<V: View>(_ content: V) throws -> Raster {
        let cgImage = try image(content)
        let width = cgImage.width, height = cgImage.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        try bytes.withUnsafeMutableBytes { data in
            let context = try XCTUnwrap(CGContext(
                data: data.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return Raster(width: width, height: height, rgba: bytes)
    }

    @MainActor
    func testAllStatesRenderNonblankAndAnimateInBothThemes() throws {
        for state in OrbState.allCases {
            for size in OrbSize.allCases {
                for theme in [OrbTheme.light, .dark] {
                    let orb = ThinkingOrb(state: state, size: size, theme: theme)
                    let first = try raster(orb.orbFrozenTime(0.6))
                    let second = try raster(orb.orbFrozenTime(3.3))
                    XCTAssertGreaterThan(first.visiblePixels, 20, "\(state) / \(size) blank at t=0.6")
                    XCTAssertGreaterThan(second.visiblePixels, 20, "\(state) / \(size) blank at t=3.3")
                    XCTAssertNotEqual(first, second, "\(state) / \(size) frames did not change")
                    XCTAssertEqual(first.width, size.rawValue * 2)
                    XCTAssertEqual(first.height, size.rawValue * 2)
                }
            }
        }
    }

    @MainActor
    func testAutoThemeFollowsEnvironmentAndExplicitThemeOverridesIt() throws {
        for state in OrbState.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let expected = try raster(ThinkingOrb(state: state, theme: scheme == .dark ? .dark : .light)
                    .orbFrozenTime(1.7))
                let automatic = try raster(ThinkingOrb(state: state, theme: .auto)
                    .environment(\.colorScheme, scheme).orbFrozenTime(1.7))
                let explicit = try raster(ThinkingOrb(state: state, theme: scheme == .dark ? .dark : .light)
                    .environment(\.colorScheme, scheme == .dark ? .light : .dark).orbFrozenTime(1.7))
                XCTAssertEqual(automatic, expected, "\(state) automatic theme mismatch")
                XCTAssertEqual(explicit, expected, "\(state) explicit theme should override environment")
            }
            let light = try raster(ThinkingOrb(state: state, theme: .light).orbFrozenTime(1.7))
            let dark = try raster(ThinkingOrb(state: state, theme: .dark).orbFrozenTime(1.7))
            XCTAssertNotEqual(light.rgba, dark.rgba, "\(state) theme must change ink")
            XCTAssertEqual(light.alpha, dark.alpha, "\(state) theme must preserve the geometry")
        }
    }

    @MainActor
    func testScaledDisplaySizesUseExactBoundsWithoutBlanking() throws {
        for state in OrbState.allCases {
            for points in [20.0, 28, 32, 44, 64, 88] {
                let preset: OrbSize = points <= 32 ? .px20 : .px64
                let result = try raster(ThinkingOrb(state: state, size: preset, displaySize: points)
                    .orbFrozenTime(1.7))
                XCTAssertEqual(result.width, Int(points * 2), "\(state) / \(points) width")
                XCTAssertEqual(result.height, Int(points * 2), "\(state) / \(points) height")
                XCTAssertGreaterThan(result.visiblePixels, 20, "\(state) / \(points) blank")
            }
        }
    }

    @MainActor
    func testPausedMatchesDeterministicStaticFrame() throws {
        for state in OrbState.allCases {
            for size in OrbSize.allCases {
                let speed = 1.3
                let time = OrbSpec.reducedMotionT * resolvePreset(state, size).speed * speed
                let expected = try raster(ThinkingOrb(state: state, size: size, speed: speed)
                    .orbFrozenTime(time))
                let paused = ThinkingOrb(state: state, size: size, speed: speed, paused: true)
                let pausedFrame = try raster(paused)
                XCTAssertEqual(pausedFrame, expected, "\(state) / \(size) pause frame")
                XCTAssertEqual(try raster(paused), pausedFrame, "\(state) / \(size) pause must remain static")
            }
        }
    }

    @MainActor
    func testFrozenTimeIsIndependentOfPlaybackSpeed() throws {
        for state in OrbState.allCases {
            let first = try raster(ThinkingOrb(state: state, speed: 0.5).orbFrozenTime(1.7))
            let second = try raster(ThinkingOrb(state: state, speed: 3).orbFrozenTime(1.7))
            XCTAssertEqual(first, second, "\(state) frozen engine time must not be speed-scaled")
        }
    }

    @MainActor
    func testWriteContactSheet() throws {
        guard let outDir = ProcessInfo.processInfo.environment["ORB_SNAPSHOT_DIR"] else {
            throw XCTSkip("set ORB_SNAPSHOT_DIR to write the visual contact sheet")
        }
        let sheet = HStack(alignment: .top, spacing: 0) {
            gallery(dark: false)
            gallery(dark: true)
        }
        let output = try image(sheet, scale: 2)
        let dir = URL(fileURLWithPath: outDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("all-states-contact-sheet.png")
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, output, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        print("SwiftUI contact sheet: \(url.path) (\(output.width) × \(output.height))")
    }

    @MainActor
    private func gallery(dark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(dark ? "Dark appearance" : "Light appearance")
                .font(.system(size: 20, weight: .semibold, design: .rounded))
            Text("28 pt · 32 pt · 64 pt / frozen at 1.7 s")
                .font(.system(size: 12))
                .foregroundStyle(dark ? Color.white.opacity(0.65) : Color.black.opacity(0.65))
            ForEach(OrbState.allCases, id: \.rawValue) { state in
                HStack(spacing: 20) {
                    Text(state.rawValue.capitalized)
                        .font(.system(size: 14, weight: .medium))
                        .frame(width: 100, alignment: .leading)
                    ForEach([28.0, 32, 64], id: \.self) { points in
                        ThinkingOrb(state: state, size: points <= 32 ? .px20 : .px64,
                                    theme: dark ? .dark : .light, displaySize: points)
                            .orbFrozenTime(1.7)
                            .frame(width: 68, height: 70)
                    }
                }
            }
        }
        .padding(24)
        .foregroundStyle(dark ? Color.white : Color.black)
        .background(dark ? Color(white: 0.055) : Color(white: 0.97))
        .environment(\.colorScheme, dark ? .dark : .light)
    }
}
