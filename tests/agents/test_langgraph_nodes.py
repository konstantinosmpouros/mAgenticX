from __future__ import annotations


def test_retail_state_supports_dict_style_access(agents_service):
    retail_nodes = __import__("langgraph_agents.retail_agent_v1.nodes", fromlist=["RetailV1_State"])
    state = retail_nodes.RetailV1_State(message_id="m1", messages=[{"role": "user", "content": "hello"}])

    assert state["message_id"] == "m1"
    assert state["messages"] == [{"role": "user", "content": "hello"}]


def test_hr_state_supports_dict_style_access(agents_service):
    hr_nodes = __import__("langgraph_agents.hr_policies_agent_v1.nodes", fromlist=["HRPoliciesV1_State"])
    state = hr_nodes.HRPoliciesV1_State(messages=[{"role": "user", "content": "policy"}], reflection_str="Needs sources")

    assert state["messages"] == [{"role": "user", "content": "policy"}]
    assert state["reflection_str"] == "Needs sources"
