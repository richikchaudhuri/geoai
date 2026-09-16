#!/usr/bin/env python3
"""Generate a scratch-only executable from the actual XCTest method bodies.

This is a Command Line Tools fallback, not an XCTest runner. Assertions fail
the executable; no compatibility module is installed or included in the app.
The unchanged XCTest suite remains the authoritative Xcode/CI test target.
"""
from pathlib import Path
import json
import re
import sys

project = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
tests = project / "Packages/GeoAICore/Tests/GeoAICoreTests/GeoAICoreTests.swift"
source = tests.read_text()
source = source.replace("import XCTest\n", "").replace("@testable import GeoAICore\n", "")
fixture = tests.parent / "Fixtures/snapshot.json"
resource_expression = 'Bundle.module.url(forResource: "snapshot", withExtension: "json", subdirectory: "Fixtures")'
if resource_expression not in source:
    raise SystemExit("Fixture expression changed; update the standalone generator.")
source = source.replace(resource_expression, f"URL(fileURLWithPath: {json.dumps(str(fixture))})")

replacements = {
    "XCTestCase": "CheckSuite",
    "XCTAssertEqual": "checkEqual", "XCTAssertNotEqual": "checkNotEqual",
    "XCTAssertTrue": "checkTrue", "XCTAssertFalse": "checkFalse",
    "XCTAssertNil": "checkNil", "XCTAssertNotNil": "checkNotNil",
    "XCTAssertNoThrow": "checkNoThrow", "XCTAssertThrowsError": "checkThrows",
    "XCTUnwrap": "requireValue", "XCTFail": "failCheck",
}
for old, new in replacements.items():
    source = re.sub(r"\b" + old + r"\b", new, source)
if re.search(r"\bXCT\w+", source):
    raise SystemExit("Unsupported XCTest API; extend the standalone assertions.")

core_source, http_source = source.split("final class AssessmentRepositoryTests", 1)
core_methods = re.findall(r"func (test\w+)\(\)([^\{]*)\{", core_source)
http_methods = re.findall(r"func (test\w+)\(\)([^\{]*)\{", http_source)
if len(core_methods) + len(http_methods) != len(re.findall(r"\bfunc test\w+", source)):
    raise SystemExit("A test method has an unsupported signature; refusing partial verification.")

assertions = r'''
// Generated only in the scratch directory. Never linked into the GeoAI app.
class CheckSuite { func setUp() {} ; func tearDown() {} }
struct CheckFailure: Error {}
func failCheck(_ message: String = "") -> Never { fatalError("CHECK FAILED: " + message) }
func checkEqual<T: Equatable>(_ a: T, _ b: T) { if a != b { failCheck("\(a) != \(b)") } }
func checkNotEqual<T: Equatable>(_ a: T, _ b: T) { if a == b { failCheck("unexpected equal values \(a)") } }
func checkTrue(_ value: Bool) { if !value { failCheck("expected true") } }
func checkFalse(_ value: Bool) { if value { failCheck("expected false") } }
func checkNil<T>(_ value: T?) { if value != nil { failCheck("expected nil") } }
func checkNotNil<T>(_ value: T?) { if value == nil { failCheck("expected non-nil") } }
func requireValue<T>(_ value: T?) throws -> T { guard let value else { throw CheckFailure() }; return value }
func checkNoThrow<T>(_ expression: @autoclosure () throws -> T) { do { _ = try expression() } catch { failCheck("unexpected error \(error)") } }
func checkThrows<T>(_ expression: @autoclosure () throws -> T) { do { _ = try expression(); failCheck("expected thrown error") } catch {} }
'''
runner = ["\n@main struct CoreChecks { static func main() async throws {"]
for name, methods in [("GeoAICoreTests", core_methods), ("AssessmentRepositoryTests", http_methods)]:
    runner.append("do {\nlet suite = " + name + "()")
    for method, effects in methods:
        prefix = ("try " if "throws" in effects else "") + ("await " if "async" in effects else "")
        runner.append(f'suite.setUp(); {prefix}suite.{method}(); suite.tearDown(); print("PASS {method}")')
    runner.append("}")
count = len(core_methods) + len(http_methods)
runner.append(f'print("PASS: {count} checks; HTTP mocked; no live services")\n}}}}\n')
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(assertions + source + "\n".join(runner))
print(f"Generated {count} regression methods from {tests.name}")
