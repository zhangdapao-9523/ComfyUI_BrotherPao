from comfy_api.latest import io


class IsNoInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_IsNoInput",
            display_name="是否无输入",
            category="❤️‍🩹炮哥Nodes/实用工具",
            description="检测输入是否为空。当上游节点被忽略或未接收到任何值时输出True，否则输出False。",
            inputs=[
                io.Boolean.Input(
                    "revert",
                    default=False,
                    tooltip="反转输出结果。开启后：有输入输出True，无输入输出False。",
                ),
                io.AnyType.Input(
                    "any_input",
                    optional=True,
                    tooltip="任意类型的输入。如果连接的节点被忽略则接收到None。",
                ),
            ],
            outputs=[io.Boolean.Output(display_name="boolean")],
        )

    @classmethod
    def execute(cls, revert=False, any_input=None):
        is_no_input = any_input is None
        if revert:
            is_no_input = not is_no_input
        return io.NodeOutput(is_no_input)
