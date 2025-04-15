
class Agent():
    def __init__(self, chain, llm=None, template=None, structure_output=None):
        self.chain = chain
        self.tool_calls = {}
        self.response = ""
    
    def _build(self,):
        pass
    
    def invoke(self, message):
        self.response = self.chain.invoke(message)
        return self.response
    
    def run(self, message):
        self.response = self.chain.invoke(message)
        return self.response
    
    def _tool_extraction(self, chunk):
        if chunk.tool_call_chunks:
            for tool_chunk in chunk.tool_call_chunks:
                index = tool_chunk['index']
                if index not in self.tool_calls:
                    self.tool_calls[index] = {
                        'name': tool_chunk['name'],  # might be None at first
                        'args': '',
                        'id': tool_chunk['id']
                    }
                if tool_chunk['name'] is not None:
                    self.tool_calls[index]['name'] = tool_chunk['name']
                if tool_chunk['args']:
                    self.tool_calls[index]['args'] += tool_chunk['args']
        
        # TODO: Add the tool execution
        # TODO: Return the results and empty the tool_calls dictionary
        # TODO: OR!! Do it again but with the react agent of the langchain.
        # TODO: