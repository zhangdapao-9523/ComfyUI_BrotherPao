class IsNoInput:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "revert": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "反转输出结果。开启后：有输入输出True，无输入输出False。"
                }),
            },
            "optional": {
                "any_input": ("*", {
                    "tooltip": "任意类型的输入。如果连接的节点被忽略则接收到None。"
                }),
            },
        }

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("boolean",)
    FUNCTION = "check_input"
    CATEGORY = "❤️‍🩹炮哥Nodes/实用工具"
    DESCRIPTION = "检测输入是否为空。当上游节点被忽略或未接收到任何值时输出True，否则输出False。"

    def check_input(self, revert=False, any_input=None):
        is_no_input = any_input is None
        if revert:
            is_no_input = not is_no_input
        return (is_no_input,)


NODE_CLASS_MAPPINGS = {
    "BrotherPao_IsNoInput": IsNoInput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BrotherPao_IsNoInput": "是否无输入",
}
