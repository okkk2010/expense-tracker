#!/usr/bin/env python3
"""Offline structure/guard regression checks; these do not replace iPhone QA."""

from __future__ import annotations

import importlib.util
import plistlib
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-iphone-shortcuts.py")
SPEC = importlib.util.spec_from_file_location("build_iphone_shortcuts", SCRIPT)
assert SPEC and SPEC.loader
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def evaluate_value(value, outputs, shortcut_input):
    if not isinstance(value, dict):
        return value
    serial = value.get("WFSerializationType")
    inner = value.get("Value", {})
    if serial == "WFTextTokenAttachment":
        return evaluate_reference(inner, outputs, shortcut_input)
    if serial == "WFTextTokenString":
        string = inner["string"]
        for position, reference in inner.get("attachmentsByRange", {}).items():
            if position != "{0, 1}" or string != "\ufffc":
                raise AssertionError("Unexpected variable range")
            return evaluate_reference(reference, outputs, shortcut_input)
        return string
    if serial == "WFDictionaryFieldValue":
        return {
            evaluate_value(item["WFKey"], outputs, shortcut_input): evaluate_value(item["WFValue"], outputs, shortcut_input)
            for item in inner["WFDictionaryFieldValueItems"]
        }
    raise AssertionError(f"Unexpected serialization: {serial}")


def evaluate_reference(reference, outputs, shortcut_input):
    if reference["Type"] == "ExtensionInput":
        return shortcut_input
    if reference["Type"] == "ActionOutput":
        return outputs[reference["OutputUUID"]]
    raise AssertionError("Unexpected reference")


def simulate(workflow, header, body):
    """Interpret only emitted control/value actions; record requests, never send."""
    actions = workflow["WFWorkflowActions"]
    import_question = workflow["WFWorkflowImportQuestions"][0]
    outputs, requests, stack = {}, [], []
    for index, action in enumerate(actions):
        name = action["WFWorkflowActionIdentifier"].removeprefix(builder.ACTION_PREFIX)
        params = action["WFWorkflowActionParameters"]
        active = all(stack)
        if name == "conditional":
            mode = params["WFControlFlowMode"]
            if mode == 0:
                result = False
                if active:
                    value = evaluate_value(params["WFInput"]["Variable"], outputs, body)
                    condition = params["WFCondition"]
                    if condition == 101:
                        result = value is None or value == ""
                    elif condition == 8:
                        result = value.startswith(params["WFConditionalActionString"])
                    elif condition == 0:
                        result = value < params["WFNumberValue"]
                    else:
                        raise AssertionError(f"Unhandled condition {condition}")
                stack.append(active and result)
            elif mode == 1:
                stack[-1] = all(stack[:-1]) and not stack[-1]
            elif mode == 2:
                stack.pop()
            continue
        if not active or name == "comment":
            continue
        result = None
        if name == "gettext":
            result = header if index == import_question["ActionIndex"] else params["WFTextActionText"]
        elif name == "text.trimwhitespace":
            value = evaluate_value(params["WFInput"], outputs, body)
            result = (value or "").strip()
        elif name == "count":
            result = len(evaluate_value(params["Input"], outputs, body))
        elif name == "detect.text":
            result = evaluate_value(params["WFInput"], outputs, body)
        elif name == "output":
            return requests, evaluate_value(params["WFOutput"], outputs, body)
        elif name == "downloadurl":
            requests.append({
                "url": evaluate_value(params["WFURL"], outputs, body),
                "headers": evaluate_value(params["WFHTTPHeaders"], outputs, body),
                "body": evaluate_value(params["WFJSONValues"], outputs, body),
            })
            result = '{"status":"pending","message":"확인이 필요합니다."}'
        else:
            raise AssertionError(f"Unexpected action {name}")
        if "UUID" in params:
            outputs[params["UUID"]] = result
    return requests, None


class ReceiverShortcutTests(unittest.TestCase):
    def test_plists_are_deterministic_and_generated_artifacts_are_current(self):
        for provider in builder.PROVIDERS:
            workflow = builder.build_workflow(provider)
            encoded = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False)
            self.assertEqual(encoded, plistlib.dumps(builder.build_workflow(provider), fmt=plistlib.FMT_XML, sort_keys=False))
            path = builder.ROOT / "shortcuts" / "unsigned" / f"moa-{provider}.plist"
            self.assertEqual(plistlib.loads(path.read_bytes()), workflow)
            self.assertEqual(path.read_bytes(), encoded)

    def test_import_question_targets_blank_text_action_and_contains_no_secret(self):
        for provider, app in builder.PROVIDERS.items():
            with self.subTest(provider=provider):
                workflow = builder.build_workflow(provider)
                questions = workflow["WFWorkflowImportQuestions"]
                self.assertEqual(len(questions), 1)
                question = questions[0]
                self.assertEqual(question["Category"], "Parameter")
                self.assertEqual(question["DefaultValue"], "")
                self.assertEqual(question["ParameterKey"], "WFTextActionText")
                self.assertIn(app, question["Text"])
                target = workflow["WFWorkflowActions"][question["ActionIndex"]]
                self.assertEqual(target["WFWorkflowActionIdentifier"], builder.ACTION_PREFIX + "gettext")
                self.assertEqual(target["WFWorkflowActionParameters"][question["ParameterKey"]], "")
                xml = plistlib.dumps(workflow).decode()
                self.assertNotIn("WFWorkflowTriggers", xml)
                self.assertNotIn("WFPropertyVariableAggrandizement", xml)
                self.assertNotIn("WFWorkflowNoInputBehaviorGetClipboard", xml)
                self.assertNotIn("Copy to Clipboard", xml)
                self.assertNotIn("APP_ACCESS_TOKEN", xml)

    def test_all_output_references_point_backwards_and_control_flow_is_balanced(self):
        def references(value):
            if isinstance(value, dict):
                if value.get("Type") == "ActionOutput":
                    yield value["OutputUUID"]
                for item in value.values():
                    yield from references(item)
            elif isinstance(value, list):
                for item in value:
                    yield from references(item)

        for provider in builder.PROVIDERS:
            seen, stack = set(), []
            for action in builder.build_workflow(provider)["WFWorkflowActions"]:
                params = action["WFWorkflowActionParameters"]
                for reference in references(params):
                    self.assertIn(reference, seen)
                if "UUID" in params:
                    self.assertNotIn(params["UUID"], seen)
                    seen.add(params["UUID"])
                if action["WFWorkflowActionIdentifier"].endswith(".conditional"):
                    mode, group = params["WFControlFlowMode"], params["GroupingIdentifier"]
                    if mode == 0:
                        stack.append(group)
                    else:
                        self.assertEqual(stack[-1], group)
                        if mode == 2:
                            stack.pop()
            self.assertEqual(stack, [])

    def test_missing_incomplete_or_admin_headers_never_reach_request(self):
        for provider in builder.PROVIDERS:
            workflow = builder.build_workflow(provider)
            for header in ("", "   ", "\n\t", "Bearer ", "Bearer moa_sc_", "Bearer admin-access-key", "moa_sc_example"):
                with self.subTest(provider=provider, header=header):
                    requests, output = simulate(workflow, header, "결제 본문")
                    self.assertEqual(requests, [])
                    self.assertTrue(output)

    def test_missing_and_whitespace_body_never_reach_request(self):
        for provider in builder.PROVIDERS:
            for body in (None, "", " \n\t "):
                with self.subTest(provider=provider, body=body):
                    requests, output = simulate(builder.build_workflow(provider), "Bearer moa_sc_unit_test_only", body)
                    self.assertEqual(requests, [])
                    self.assertIn("본문", output)

    def test_valid_input_posts_only_explicit_body_and_fixed_source_to_https(self):
        for provider, app in builder.PROVIDERS.items():
            with self.subTest(provider=provider):
                workflow = builder.build_workflow(provider)
                request_actions = [a for a in workflow["WFWorkflowActions"] if a["WFWorkflowActionIdentifier"].endswith(".downloadurl")]
                self.assertEqual(len(request_actions), 1)
                params = request_actions[0]["WFWorkflowActionParameters"]
                self.assertEqual(params["WFHTTPMethod"], "POST")
                self.assertEqual(params["WFHTTPBodyType"], "JSON")
                self.assertNotIn("WFRequestVariable", params)
                self.assertNotIn("WFJSONBody", params)
                requests, output = simulate(workflow, "  Bearer moa_sc_unit_test_only\n", '  승인 12,000원\n매장 "이름" \\ 지점\n  ')
                self.assertEqual(requests, [{
                    "url": builder.DEFAULT_ENDPOINT,
                    "headers": {"Authorization": "Bearer moa_sc_unit_test_only", "Content-Type": "application/json"},
                    "body": {"body": '승인 12,000원\n매장 "이름" \\ 지점', "source_app": app},
                }])
                self.assertTrue(requests[0]["url"].startswith("https://"))
                self.assertEqual(output, '{"status":"pending","message":"확인이 필요합니다."}')


if __name__ == "__main__":
    unittest.main()
