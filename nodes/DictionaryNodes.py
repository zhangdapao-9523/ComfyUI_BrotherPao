MAX_DICT_COUNT = 10
MAX_KV_PAIRS = 5

from comfy_api.latest import io


class DictionaryUpdate(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.Custom("DICT").Input("dict1", lazy=True),
            io.Custom("DICT").Input("dict2", lazy=True),
        ]
        for i in range(3, MAX_DICT_COUNT + 1):
            inputs.append(io.Custom("DICT").Input(f"dict{i}", optional=True, lazy=True))
        return io.Schema(
            node_id="BrotherPao_DictionaryUpdate",
            display_name="字典合并",
            category="❤️‍🩹炮哥Nodes/字典操作",
            inputs=inputs,
            outputs=[io.Custom("DICT").Output(display_name="merged_dict")],
        )

    @classmethod
    def check_lazy_status(cls, **kwargs):
        needed = []
        for i in range(1, MAX_DICT_COUNT + 1):
            key = f"dict{i}"
            if key in kwargs and kwargs[key] is None:
                needed.append(key)
        return needed

    @classmethod
    def execute(cls, **kwargs):
        merged = {}
        for i in range(1, MAX_DICT_COUNT + 1):
            key = f"dict{i}"
            value = kwargs.get(key)
            if value is not None and isinstance(value, dict):
                merged.update(value)
        return io.NodeOutput(merged)


class DictionaryGet(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_DictionaryGet",
            display_name="字典取值",
            category="❤️‍🩹炮哥Nodes/字典操作",
            inputs=[
                io.Custom("DICT").Input("dict"),
                io.String.Input("key", default="", multiline=False),
                io.String.Input("default_value", optional=True, default="", multiline=False),
            ],
            outputs=[io.String.Output(display_name="value")],
        )

    @classmethod
    def execute(cls, dict, key, default_value=""):
        if not hasattr(dict, "get"):
            return io.NodeOutput(str(default_value))
        return io.NodeOutput(str(dict.get(key, default_value)))


class DictionaryNew(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.String.Input("key1", default="", multiline=False),
            io.String.Input("value1", default="", multiline=True),
        ]
        for i in range(2, MAX_KV_PAIRS + 1):
            inputs.append(io.String.Input(f"key{i}", optional=True, default="", multiline=False))
            inputs.append(io.String.Input(f"value{i}", optional=True, default="", multiline=True))
        return io.Schema(
            node_id="BrotherPao_DictionaryNew",
            display_name="新建字典",
            category="❤️‍🩹炮哥Nodes/字典操作",
            inputs=inputs,
            outputs=[io.Custom("DICT").Output(display_name="dict")],
        )

    @classmethod
    def execute(cls, key1="", value1="", **kwargs):
        result = {}
        if key1:
            result[key1] = value1
        for i in range(2, MAX_KV_PAIRS + 1):
            k = kwargs.get(f"key{i}", "")
            v = kwargs.get(f"value{i}", "")
            if k:
                result[k] = v
        return io.NodeOutput(result)
